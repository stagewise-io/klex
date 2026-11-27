import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { JSONObject } from '@ai-sdk/provider';
import { generateText } from 'ai';
import z from 'zod';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { ProviderModelResolver } from '@/provider-registry';
import { summarizeGenerationFailure } from '@/session-history/generation-health';

import type { ExtendedUIMessage } from '../../message-types';
import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extension-api';
import {
  type SoulFailure,
  soulFailureMessages,
  soulFailureSchema,
} from './failure';
import { getSoulGenerationSystemPrompt } from './generation-system-prompt';
import { formatSoulGenerationUserMessage } from './generation-user-message';
import { readSoulState, readSoulVersion, writeSoulFailure } from './state';
import { getSystemPromptPart as systemPromptPartSoul } from './system-prompt-part/with-soul';

/**
 * File name of the soul definition inside the extension's global data
 * directory.
 */
const SOUL_FILE = 'SOUL.md';

/** Maximum persisted soul size, unchanged from the former writing tool. */
const MAX_SOUL_LENGTH = 10_000;
const instructionsSchema = z.string().trim().max(10_000);

/** Removes nested soul tags that could break the trusted prompt wrapper. */
const SOUL_TAG_PATTERN = /<\/?soul\b[^>]*>/gi;
/** Reads current soul content without adopting the agent's identity or creating files. */
export function readSoul(soulDirectory: string): string | null {
  let content: string;
  try {
    content = readFileSync(join(soulDirectory, SOUL_FILE), 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const sanitized = content.replace(SOUL_TAG_PATTERN, '');
  return sanitized.trim().length === 0 ? null : sanitized;
}

export type SoulErrorCode =
  | 'invalid_instructions'
  | 'soul_not_found'
  | 'operation_in_progress'
  | 'soul_changed'
  | 'no_chat_models'
  | 'generation_failed'
  | 'request_cancelled';

export class SoulError extends Error {
  constructor(
    readonly code: SoulErrorCode,
    message: string,
    readonly failure?: SoulFailure,
  ) {
    super(message);
    this.name = 'SoulError';
  }
}

/** Request-scoped generation; no session, tools, or background retries. */
export interface Soul {
  get(): string | null;
  getStatus(): Promise<{ failure: SoulFailure | null }>;
  create(instructions: string, signal?: AbortSignal): Promise<string>;
  update(instructions: string, signal?: AbortSignal): Promise<string>;
}

export interface SoulDependencies {
  logging: RootLogger;
  soulDirectory: string;
  config: Pick<Config, 'getModelSelection'>;
  modelResolver: Pick<
    ProviderModelResolver,
    'getLanguageModel' | 'resolveModel'
  >;
}

class SoulModule implements Soul {
  private writing = false;

  constructor(
    private readonly deps: Omit<SoulDependencies, 'logging'> & {
      logger: ModuleLogger;
    },
  ) {}

  get(): string | null {
    return readSoul(this.deps.soulDirectory);
  }

  async getStatus(): Promise<{ failure: SoulFailure | null }> {
    const state = await readSoulState(this.deps.soulDirectory);
    const failure = state?.payload.failure;
    // Legacy failures have no version evidence: retain them until cleared.
    // Parse the store first, even if its failure has since been resolved.
    if (
      failure?.soulVersion !== undefined &&
      failure.soulVersion !== readSoulVersion(this.deps.soulDirectory)
    ) {
      return { failure: null };
    }
    return {
      failure: failure ? soulFailureSchema.parse(failure) : null,
    };
  }

  create(instructions: string, signal?: AbortSignal): Promise<string> {
    return this.write('create', instructions, signal);
  }

  update(instructions: string, signal?: AbortSignal): Promise<string> {
    return this.write('update', instructions, signal);
  }

  private async write(
    mode: 'create' | 'update',
    instructions: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const parsed = instructionsSchema.safeParse(instructions);
    if (!parsed.success || (mode === 'create' && !parsed.data)) {
      throw new SoulError(
        'invalid_instructions',
        mode === 'create'
          ? 'Creation instructions must contain 1–10,000 characters'
          : 'Update instructions must be a string of at most 10,000 characters; leave empty to optimize',
      );
    }
    if (this.writing) {
      throw new SoulError(
        'operation_in_progress',
        'A soul operation is already in progress',
      );
    }
    this.writing = true;
    try {
      signal?.throwIfAborted();
      const previous = this.get();
      if (mode === 'update' && previous === null) {
        throw new SoulError(
          'soul_not_found',
          'No soul exists; use POST to create it',
        );
      }
      const content = await this.generate(
        mode,
        parsed.data,
        mode === 'update' ? previous : null,
        signal,
      );
      signal?.throwIfAborted();
      // Detect external edits as well as serializing all API writers.
      if (this.get() !== previous) {
        throw new SoulError(
          'soul_changed',
          'The soul changed during generation; retry the request',
        );
      }
      // A failed generation or write never truncates the existing document.
      saveSoul(this.deps.soulDirectory, content);
      try {
        await writeSoulFailure(this.deps.soulDirectory, null);
      } catch (error) {
        this.deps.logger.warn(
          { error },
          'Soul saved but failed to clear generation failure status',
        );
      }
      return content;
    } catch (error) {
      if (signal?.aborted) {
        throw new SoulError(
          'request_cancelled',
          'The soul request was cancelled',
        );
      }
      throw error;
    } finally {
      this.writing = false;
    }
  }

  private async generate(
    mode: 'create' | 'update',
    instructions: string,
    previous: string | null,
    signal?: AbortSignal,
  ): Promise<string> {
    const models = this.deps.config.getModelSelection('chat');
    if (models.length === 0) {
      const failure: SoulFailure = {
        kind: 'soul_generation_failed',
        category: 'configuration',
        reason: 'no_chat_models',
        providerId: null,
        providerType: null,
        modelId: null,
        statusCode: null,
        message: soulFailureMessages.configuration,
      };
      await this.persistFailure(failure);
      throw new SoulError(
        'no_chat_models',
        'Configure a chat model before generating a soul',
        failure,
      );
    }
    const operation = mode === 'update' && !instructions ? 'optimize' : mode;
    const system = getSoulGenerationSystemPrompt(operation);
    const prompt = formatSoulGenerationUserMessage({
      operation,
      instructions,
      existingSoul: previous,
    });
    let failure: SoulFailure | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const entry = models[attempt % models.length]!;
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new Error('Soul generation timed out')),
        60_000,
      );
      const attemptSignal = AbortSignal.any([
        timeout.signal,
        ...(signal ? [signal] : []),
      ]);
      let providerType: string | undefined;
      let invalidReason: SoulFailure['reason'] | undefined;
      let resolving = true;
      try {
        const resolved = this.deps.modelResolver.resolveModel(entry);
        providerType = resolved.providerType;
        const model = this.deps.modelResolver.getLanguageModel(entry);
        resolving = false;
        const result = await abortable(
          () =>
            generateText({
              model,
              system,
              prompt,
              maxRetries: 0,
              maxOutputTokens: 8_192,
              abortSignal: attemptSignal,
              providerOptions: resolved.providerOptions as
                | Record<string, JSONObject>
                | undefined,
              telemetry: { isEnabled: true, functionId: `soul.${operation}` },
            }),
          attemptSignal,
        );
        const content = result.text.replace(SOUL_TAG_PATTERN, '').trim();
        if (
          result.finishReason !== 'stop' ||
          !content ||
          content.length > MAX_SOUL_LENGTH ||
          /^```/u.test(content)
        ) {
          invalidReason =
            result.finishReason === 'length' || content.length > MAX_SOUL_LENGTH
              ? 'length'
              : !content
                ? 'empty_output'
                : 'rejected_format';
          throw new Error('Soul model returned incomplete or invalid content');
        }
        return content;
      } catch (error) {
        signal?.throwIfAborted();
        const summary = summarizeGenerationFailure(
          error,
          { ...entry, providerType },
          timeout.signal.aborted ? 'timeout' : resolving ? 'configuration' : '',
        );
        const category = invalidReason ? 'invalid_output' : summary.category;
        failure = {
          ...summary,
          kind: 'soul_generation_failed',
          category,
          reason: invalidReason ?? 'provider_error',
          message: soulFailureMessages[category],
          statusCode:
            summary.statusCode !== null &&
            Number.isInteger(summary.statusCode) &&
            summary.statusCode >= 100 &&
            summary.statusCode <= 599
              ? summary.statusCode
              : null,
        };
        // Never log prompts, responses, or provider errors containing either.
        this.deps.logger.warn(
          {
            attempt: attempt + 1,
            ...failure,
          },
          'Soul generation attempt failed',
        );
      } finally {
        clearTimeout(timer);
      }
    }
    await this.persistFailure(failure!);
    throw new SoulError(
      'generation_failed',
      'Soul generation failed after 3 attempts',
      failure,
    );
  }

  private async persistFailure(failure: SoulFailure): Promise<void> {
    try {
      await writeSoulFailure(this.deps.soulDirectory, failure);
    } catch (error) {
      this.deps.logger.warn(
        { error },
        'Failed to persist soul generation failure status',
      );
    }
  }
}

/** Atomic persistence for API generation. */
function saveSoul(directory: string, content: string): void {
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.SOUL.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, join(directory, SOUL_FILE));
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Bounds even a provider that fails to settle promptly after cancellation. */
async function abortable<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([run(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createSoul(deps: SoulDependencies): Soul {
  const { logging, ...rest } = deps;
  return new SoulModule({
    ...rest,
    logger: logging.child({ name: 'soul', bindings: { module: 'soul' } }),
  });
}

class SoulExt implements Extension {
  /** Absolute path to the global extension data directory. */
  private readonly soulDir: string;

  /** Absolute path to `SOUL.md` inside {@link soulDir}. */
  private readonly soulPath: string;

  private retainedMessageIds = new Set<string>();
  private stepAllowed = false;

  constructor(private readonly deps: ExtensionDeps) {
    this.soulDir = deps.getDataDir(true);
    this.soulPath = join(this.soulDir, SOUL_FILE);
  }

  /**
   * Reads and returns sanitized soul content if `SOUL.md` exists and is
   * non-empty after trimming. Nested soul tags are removed so file content
   * cannot break the prompt wrapper. Returns `null` otherwise. All soul-state
   * checks (prompt, step guard, introspection) go through
   * this method so they stay consistent.
   */
  private readSoul(): string | null {
    return readSoul(this.soulDir);
  }

  onStart(): Promise<void> {
    this.retainHistory();
    return Promise.resolve();
  }

  private retainHistory(): void {
    this.retainedMessageIds = new Set(
      this.deps.getHistory().map((message) => message.id),
    );
  }

  shouldRunStep(history: ExtendedUIMessage[]): boolean {
    this.stepAllowed = this.readSoul() !== null;
    if (!this.stepAllowed) {
      for (let index = history.length - 1; index >= 0; index--) {
        if (!this.retainedMessageIds.has(history[index]!.id))
          history.splice(index, 1);
      }
    }
    return this.stepAllowed;
  }

  onStepComplete(): void {
    if (this.stepAllowed) this.retainHistory();
  }

  /**
   * Returns the wrapped soul content for the system prompt. If `SOUL.md`
   * exists in the global extension directory, its contents are enclosed in
   * the dedicated soul section. Without a soul, contributes nothing;
   * shouldRunStep drops new history and skips inference.
   *
   * Called once per step. Re-reads the file each time so manual edits
   * are picked up without restarting the session.
   */
  getSystemPromptPart(): string {
    const soul = this.readSoul();
    return soul !== null ? systemPromptPartSoul(soul) : '';
  }

  introspect(): Record<string, unknown> {
    return {
      hasSoul: this.readSoul() !== null,
      soulPath: this.soulPath,
    };
  }
}

/** Loads the agent soul read-only for a chat session. */
export const createSoulExt: ExtensionFactory = {
  identifier: 'io.stagewise/soul',
  displayName: 'Soul',
  create: (deps) => new SoulExt(deps),
};

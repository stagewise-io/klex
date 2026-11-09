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
import { generateText, type ToolSet, tool } from 'ai';
import z from 'zod';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { ProviderModelResolver } from '@/provider-registry';

import type { ExtendedUIMessage } from '../../message-types';
import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  ResolvedModel,
} from '../extension-api';
import { getSoulGenerationSystemPrompt } from './generation-system-prompt';
import { formatSoulGenerationUserMessage } from './generation-user-message';
import { getSoulGodSystemPrompt } from './god-system-prompt';
import { getSystemPromptPart as systemPromptPartSoul } from './system-prompt-part/with-soul';
import updateSoulToolDescription from './update-soul-tool-description.md';

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
const soulContentSchema = z
  .string()
  .min(1)
  .max(MAX_SOUL_LENGTH)
  .refine(
    (content) => content.replace(SOUL_TAG_PATTERN, '').trim().length > 0,
    {
      message: 'Soul content must not be blank after removing soul tags',
    },
  );

/**
 * The mode of a soul extension instance.
 *
 * - `'standard'` — used in regular (default) sessions. The extension is
 *   read-only: it drops new history and skips steps without a soul, injects
 *   the soul content, and provides no tools. The soul cannot be created or
 *   updated from a regular session.
 * - `'god'` — retains the legacy `updateSoul` tool for cloud compatibility.
 *   Does not block administration when no soul exists.
 */
type SoulMode = 'standard' | 'god';

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
  ) {
    super(message);
    this.name = 'SoulError';
  }
}

/** Request-scoped generation; no session, tools, or background retries. */
export interface Soul {
  get(): string | null;
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
      throw new SoulError(
        'no_chat_models',
        'Configure a chat model before generating a soul',
      );
    }
    const operation = mode === 'update' && !instructions ? 'optimize' : mode;
    const system = getSoulGenerationSystemPrompt(operation);
    const prompt = formatSoulGenerationUserMessage({
      operation,
      instructions,
      existingSoul: previous,
    });
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
      try {
        const model = this.deps.modelResolver.getLanguageModel(entry);
        const resolved = this.deps.modelResolver.resolveModel(entry);
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
          throw new Error('Soul model returned incomplete or invalid content');
        }
        return content;
      } catch {
        signal?.throwIfAborted();
        // Never log prompts, responses, or provider errors containing either.
        this.deps.logger.warn(
          {
            attempt: attempt + 1,
            providerId: entry.providerId,
            modelId: entry.modelId,
          },
          'Soul generation attempt failed',
        );
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SoulError(
      'generation_failed',
      'Soul generation failed after 3 attempts',
    );
  }
}

/** Shared atomic persistence for API generation and the legacy god-session tool. */
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

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly mode: SoulMode = 'standard',
  ) {
    this.soulDir = deps.getDataDir(true);
    this.soulPath = join(this.soulDir, SOUL_FILE);
  }

  /**
   * Reads and returns sanitized soul content if `SOUL.md` exists and is
   * non-empty after trimming. Nested soul tags are removed so file content
   * cannot break the prompt wrapper. Returns `null` otherwise. All soul-state
   * checks (prompt, tools, execute guard, introspection) go through
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
    this.stepAllowed = this.mode === 'god' || this.readSoul() !== null;
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
   * the dedicated soul section. Without a soul, god mode supports explicit
   * setup through the legacy tool. Standard mode contributes nothing;
   * shouldRunStep drops new history and skips inference.
   *
   * Called once per step. Re-reads the file each time so manual edits
   * are picked up without restarting the session.
   */
  getSystemPromptPart(): string {
    const soul = this.readSoul();
    if (this.mode === 'god') return getSoulGodSystemPrompt(soul);
    return soul !== null ? systemPromptPartSoul(soul) : '';
  }

  /** Legacy cloud contract: only god sessions can write a complete soul. */
  getTools(_model: ResolvedModel): ToolSet {
    if (this.mode === 'standard') return {};
    return {
      updateSoul: tool({
        description: updateSoulToolDescription,
        inputSchema: z.object({
          content: soulContentSchema,
        }),
        execute: async ({ content }) => {
          saveSoul(this.soulDir, soulContentSchema.parse(content));
          return 'Your soul has been updated.';
        },
      }),
    };
  }

  introspect(): Record<string, unknown> {
    return {
      hasSoul: this.readSoul() !== null,
      soulPath: this.soulPath,
      mode: this.mode,
    };
  }
}

/** Loads and maintains the agent soul for a standard chat session. */
export const createSoulExt: ExtensionFactory = {
  identifier: 'io.stagewise/soul',
  displayName: 'Soul',
  create: (deps) => new SoulExt(deps, 'standard'),
};

/** Loads the agent soul with the behavior required by an isolated god session. */
export const createSoulExtGod: ExtensionFactory = {
  identifier: 'io.stagewise/soul',
  displayName: 'Soul (God)',
  create: (deps) => new SoulExt(deps, 'god'),
};

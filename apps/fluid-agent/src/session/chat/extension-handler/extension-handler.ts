import { join } from 'node:path';

import type { ModelMessage } from 'ai';

import type { ExtendedUIMessage } from '@/session/types';

import type {
  BaseExtensionDeps,
  DataPartTransformers,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  StepCompleteEvent,
  StepCompleteHookResult,
  TransformationFlags,
} from '../extensions/extension-api';

/**
 * Normalizes a transformation hook return value into `{ history, flags }`.
 * Extensions can return either the history directly (shorthand) or an object
 * with history + flags.
 */
function normalizeResult<T>(
  result: T | { history: T; flags: TransformationFlags },
): { history: T; flags: TransformationFlags } {
  if (
    typeof result === 'object' &&
    result !== null &&
    'history' in result &&
    'flags' in result
  ) {
    return result as { history: T; flags: TransformationFlags };
  }
  return { history: result as T, flags: {} };
}

function mergeFlags(
  accumulated: TransformationFlags,
  incoming: TransformationFlags,
): TransformationFlags {
  return {
    hasCompacted: accumulated.hasCompacted || incoming.hasCompacted,
  };
}

export interface ExtensionHandler {
  /** All instantiated extensions. */
  readonly extensions: readonly Extension[];

  /**
   * Run `historyTransformer` across all extensions in order.
   * Each extension receives the output history of the previous one.
   * Flags from all extensions are merged (OR semantics).
   */
  runHistoryTransformers: (
    history: ExtendedUIMessage[],
  ) => Promise<{ history: ExtendedUIMessage[]; flags: TransformationFlags }>;

  /**
   * Run `contextTransformer` across all extensions in order.
   * Each extension receives the output history of the previous one.
   * Flags from all extensions are merged (OR semantics).
   */
  runContextTransformers: (
    history: ModelMessage[],
  ) => Promise<{ history: ModelMessage[]; flags: TransformationFlags }>;

  /**
   * Collect and merge all `dataPartTransformers` from all extensions.
   * Throws if two extensions register a transformer for the same data part
   * type — only one converter per type is allowed.
   */
  getDataPartTransformers: () => DataPartTransformers;

  /**
   * Run `onStepComplete` across all extensions **in parallel** via
   * `Promise.allSettled`. The step waits for all hooks to settle
   * before continuing.
   *
   * Each extension receives a structured clone of the
   * {@link StepCompleteEvent}. Errors from individual extensions are
   * caught, logged, and do not break the step — one extension's hook
   * failure does not affect others.
   *
   * If any extension returns `{ stop: true }`, the returned object
   * will have `stop: true` and the first non-empty `stopReason`.
   */
  runStepCompleteHooks: (
    event: StepCompleteEvent,
  ) => Promise<{ stop: boolean; stopReason: string | null }>;
}

export interface ExtensionHandlerDependencies {
  factories: ExtensionFactory[];
  extensionDeps: BaseExtensionDeps;
  /** Root data directory of the agent. */
  dataDirectory: string;
  /** ID of the session that owns these extensions. */
  sessionId: string;
}

class ExtensionHandlerModule implements ExtensionHandler {
  readonly extensions: readonly Extension[];

  private readonly extensionDeps: BaseExtensionDeps;

  constructor(deps: {
    factories: ExtensionFactory[];
    extensionDeps: BaseExtensionDeps;
    dataDirectory: string;
    sessionId: string;
  }) {
    this.extensionDeps = deps.extensionDeps;

    // Enforce identifier uniqueness before instantiating anything.
    const seen = new Set<string>();
    for (const factory of deps.factories) {
      if (seen.has(factory.identifier)) {
        throw new Error(
          `Duplicate extension identifier: "${factory.identifier}" — extension identifiers must be unique.`,
        );
      }
      seen.add(factory.identifier);
    }

    this.extensions = deps.factories.map((factory) => {
      const scopedDeps: ExtensionDeps = {
        ...deps.extensionDeps,
        getDataDir: (global = false) =>
          global
            ? join(deps.dataDirectory, 'extensions', factory.identifier)
            : join(
                deps.dataDirectory,
                'sessions',
                deps.sessionId,
                'extensions',
                factory.identifier,
              ),
      };

      const ext = factory.create(scopedDeps);

      if (ext.identifier !== factory.identifier) {
        throw new Error(
          `Extension identifier mismatch: factory declares "${factory.identifier}" but the created extension reports "${ext.identifier}".`,
        );
      }

      return ext;
    });
  }

  async runHistoryTransformers(
    history: ExtendedUIMessage[],
  ): Promise<{ history: ExtendedUIMessage[]; flags: TransformationFlags }> {
    let currentHistory = history;
    let flags: TransformationFlags = {};

    for (const ext of this.extensions) {
      if (!ext.historyTransformer) continue;
      const result = await ext.historyTransformer(currentHistory);
      const normalized = normalizeResult(result);
      currentHistory = normalized.history;
      flags = mergeFlags(flags, normalized.flags);
    }

    return { history: currentHistory, flags };
  }

  async runContextTransformers(
    history: ModelMessage[],
  ): Promise<{ history: ModelMessage[]; flags: TransformationFlags }> {
    let currentHistory = history;
    let flags: TransformationFlags = {};

    for (const ext of this.extensions) {
      if (!ext.contextTransformer) continue;
      const result = await ext.contextTransformer(currentHistory);
      const normalized = normalizeResult(result);
      currentHistory = normalized.history;
      flags = mergeFlags(flags, normalized.flags);
    }

    return { history: currentHistory, flags };
  }

  getDataPartTransformers(): DataPartTransformers {
    // Accumulate in a loose record — the mapped type makes per-key
    // assignment structurally impossible, so we cast the final result.
    const merged = {} as Record<
      string,
      DataPartTransformers[keyof DataPartTransformers]
    >;

    for (const ext of this.extensions) {
      if (!ext.dataPartTransformers) continue;

      for (const [key, transformer] of Object.entries(
        ext.dataPartTransformers,
      )) {
        if (merged[key]) {
          throw new Error(
            `Duplicate data part transformer for type "${key}" — only one converter per type is allowed.`,
          );
        }
        merged[key] = transformer;
      }
    }

    return merged as unknown as DataPartTransformers;
  }

  async runStepCompleteHooks(
    event: StepCompleteEvent,
  ): Promise<{ stop: boolean; stopReason: string | null }> {
    const hooks = this.extensions
      .filter((ext) => ext.onStepComplete)
      .map((ext) => ext.onStepComplete!);

    if (hooks.length === 0) {
      return { stop: false, stopReason: null };
    }

    // Launch all hooks in parallel, each with its own structured clone
    // so mutations don't leak between extensions or back to the caller.
    // The async wrapper ensures synchronous throws become rejected promises
    // that Promise.allSettled can catch.
    const results = await Promise.allSettled(
      hooks.map(async (hook) => hook(structuredClone(event))),
    );

    let stop = false;
    let stopReason: string | null = null;

    for (let i = 0; i < results.length; i++) {
      const settled = results[i]!;
      if (settled.status === 'rejected') {
        // Log the error but don't break — other hooks already ran in parallel.
        this.extensionDeps.logger.error(
          { error: settled.reason, extensionIndex: i },
          'Extension onStepComplete hook failed',
        );
        continue;
      }

      const hookResult = settled.value as StepCompleteHookResult;
      if (hookResult && typeof hookResult === 'object' && hookResult.stop) {
        stop = true;
        if (stopReason === null && hookResult.stopReason) {
          stopReason = hookResult.stopReason;
        }
      }
    }

    return { stop, stopReason };
  }
}

export function createExtensionHandler(
  deps: ExtensionHandlerDependencies,
): ExtensionHandler {
  return new ExtensionHandlerModule({
    factories: deps.factories,
    extensionDeps: deps.extensionDeps,
    dataDirectory: deps.dataDirectory,
    sessionId: deps.sessionId,
  });
}

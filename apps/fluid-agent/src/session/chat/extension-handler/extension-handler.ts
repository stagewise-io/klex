import type { ModelMessage } from 'ai';

import type { ExtendedUIMessage } from '@/session/types';

import type {
  DataPartTransformers,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
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
   * Run `onHistoryPreProcessing` across all extensions in order (2.2.4).
   * Each extension receives the output history of the previous one.
   * Flags from all extensions are merged (OR semantics).
   */
  onHistoryPreProcessing: (
    history: ExtendedUIMessage[],
  ) => Promise<{ history: ExtendedUIMessage[]; flags: TransformationFlags }>;

  /**
   * Run `onHistoryPostProcessing` across all extensions in order (2.2.6).
   * Each extension receives the output history of the previous one.
   * Flags from all extensions are merged (OR semantics).
   */
  onHistoryPostProcessing: (
    history: ModelMessage[],
  ) => Promise<{ history: ModelMessage[]; flags: TransformationFlags }>;

  /**
   * Collect and merge all `dataPartTransformers` from all extensions (2.2.5).
   * Throws if two extensions register a transformer for the same data part
   * type — only one converter per type is allowed.
   */
  getDataPartTransformers: () => DataPartTransformers;
}

export interface ExtensionHandlerDependencies {
  factories: ExtensionFactory[];
  extensionDeps: ExtensionDeps;
}

class ExtensionHandlerModule implements ExtensionHandler {
  readonly extensions: readonly Extension[];

  constructor(deps: {
    factories: ExtensionFactory[];
    extensionDeps: ExtensionDeps;
  }) {
    this.extensions = deps.factories.map((factory) =>
      factory(deps.extensionDeps),
    );
  }

  async onHistoryPreProcessing(
    history: ExtendedUIMessage[],
  ): Promise<{ history: ExtendedUIMessage[]; flags: TransformationFlags }> {
    let currentHistory = history;
    let flags: TransformationFlags = {};

    for (const ext of this.extensions) {
      if (!ext.onHistoryPreProcessing) continue;
      const result = await ext.onHistoryPreProcessing(currentHistory);
      const normalized = normalizeResult(result);
      currentHistory = normalized.history;
      flags = mergeFlags(flags, normalized.flags);
    }

    return { history: currentHistory, flags };
  }

  async onHistoryPostProcessing(
    history: ModelMessage[],
  ): Promise<{ history: ModelMessage[]; flags: TransformationFlags }> {
    let currentHistory = history;
    let flags: TransformationFlags = {};

    for (const ext of this.extensions) {
      if (!ext.onHistoryPostProcessing) continue;
      const result = await ext.onHistoryPostProcessing(currentHistory);
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
}

export function createExtensionHandler(
  deps: ExtensionHandlerDependencies,
): ExtensionHandler {
  return new ExtensionHandlerModule({
    factories: deps.factories,
    extensionDeps: deps.extensionDeps,
  });
}

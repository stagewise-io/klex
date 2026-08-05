import { join } from 'node:path';

import { context } from '@opentelemetry/api';
import type { ModelMessage, ToolSet } from 'ai';

import type { IntrospectionScope } from '@/introspection';
import type { Usage } from '@/session/types';

import type {
  BaseExtensionDeps,
  DataPartTransformers,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  GenerateTextResult,
  ResolvedModel,
  StepCompleteEvent,
  TransformationFlags,
} from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';
import { withExtensionIdentifier } from '../utils/tracing';
import { extractUsage } from '../utils/usage';

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
   * Run `onStepStart` across all extensions **in parallel** via
   * `Promise.allSettled`. The step waits for all hooks to settle
   * before proceeding.
   *
   * This is a fire-and-observe lifecycle notification — hooks cannot
   * influence what the model sees or cancel the step. Errors from
   * individual extensions are caught, logged, and do not break other
   * hooks.
   */
  runStepStartHooks: () => Promise<void>;

  /**
   * Call `onStart` on all extensions that define it, sequentially in
   * factory order. Used during session startup to initialize owned
   * resources (workers, connections, etc.).
   *
   * If a hook throws, startup aborts immediately and the error
   * propagates to the caller.
   */
  start: () => Promise<void>;

  /**
   * Call `onClose` on all extensions that define it, sequentially in
   * reverse factory order (LIFO). Used during session shutdown to
   * release owned resources.
   *
   * Errors are caught and logged per-extension — cleanup is best-effort
   * and one extension's failure does not prevent others from closing.
   */
  close: () => Promise<void>;

  /**
   * Collect and merge `getTools(model)` return values from all extensions
   * that define the method. Called per step after the model has been
   * resolved, so extensions can make model-aware decisions about which
   * tools to expose. The merged `ToolSet` is passed to the generation
   * runner.
   *
   * Throws if two extensions provide a tool with the same name —
   * tool names must be unique across all extensions.
   */
  getTools: (model: ResolvedModel) => ToolSet;

  /**
   * Run `historyTransformer` across all extensions in order.
   * Each extension receives the output history of the previous one.
   * Flags from all extensions are merged (OR semantics).
   *
   * If an extension's transformer throws, the error is caught, logged
   * with the extension identifier, and re-thrown — the caller (step)
   * must catch it and abort the step. No subsequent transformers run.
   */
  runHistoryTransformers: (
    history: ExtendedUIMessage[],
    model: ResolvedModel,
  ) => Promise<{ history: ExtendedUIMessage[]; flags: TransformationFlags }>;

  /**
   * Run `contextTransformer` across all extensions in order.
   * Each extension receives the output history of the previous one.
   * Flags from all extensions are merged (OR semantics).
   *
   * If an extension's transformer throws, the error is caught, logged
   * with the extension identifier, and re-thrown — the caller (step)
   * must catch it and abort the step. No subsequent transformers run.
   */
  runContextTransformers: (
    history: ModelMessage[],
    model: ResolvedModel,
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
   */
  runStepCompleteHooks: (event: StepCompleteEvent) => Promise<void>;
}

export interface ExtensionHandlerDependencies {
  factories: ExtensionFactory[];
  extensionDeps: BaseExtensionDeps;
  /** Root data directory of the agent. */
  dataDirectory: string;
  /** ID of the session that owns these extensions. */
  sessionId: string;
  /** Introspection scope for registering extension state. */
  introspectionScope: IntrospectionScope;
  /**
   * Called after an extension's `generateText` call succeeds, with the
   * extracted usage data. Used by the session to track per-extension
   * token consumption separately from chat usage.
   */
  onExtensionUsage?: (identifier: string, usage: Usage) => void;
}

class ExtensionHandlerModule implements ExtensionHandler {
  readonly extensions: readonly Extension[];

  private readonly extensionDeps: BaseExtensionDeps;
  /** Maps each extension instance to its factory identifier for logging. */
  private readonly identifiersByExtension: Map<Extension, string>;

  /** Maps each extension identifier to its factory-declared display name. */
  private readonly displayNamesByIdentifier: Map<string, string | undefined>;

  constructor(deps: {
    factories: ExtensionFactory[];
    extensionDeps: BaseExtensionDeps;
    dataDirectory: string;
    sessionId: string;
    introspectionScope: IntrospectionScope;
    onExtensionUsage?: (identifier: string, usage: Usage) => void;
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

    const baseGenerateText = deps.extensionDeps.generateText;
    const onExtensionUsage = deps.onExtensionUsage;

    this.identifiersByExtension = new Map();
    this.displayNamesByIdentifier = new Map();

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
        // Wrap generateText to set the extension identifier in the OTel
        // context (used for trace attribution as gen_ai.agent.name =
        // "extension:{identifier}") and to track per-extension token usage
        // on success.
        generateText: async (args) => {
          const ctx = withExtensionIdentifier(
            context.active(),
            factory.identifier,
          );
          const result: GenerateTextResult = await context.with(ctx, () =>
            baseGenerateText(args),
          );
          if (result.success && onExtensionUsage) {
            onExtensionUsage(factory.identifier, extractUsage(result.usage));
          }
          return result;
        },
      };

      const ext = factory.create(scopedDeps);
      this.identifiersByExtension.set(ext, factory.identifier);
      this.displayNamesByIdentifier.set(
        factory.identifier,
        factory.displayName,
      );

      // Register extension state in the introspection tree if it
      // implements introspect(). The closure captures `ext` so that
      // `this` binding is preserved when introspect() is called lazily.
      if (ext.introspect) {
        deps.introspectionScope
          .child(factory.identifier)
          .introspect(() => ext.introspect!() as object | null);
      }

      return ext;
    });
  }

  async runStepStartHooks(): Promise<void> {
    const extensions = this.extensions.filter((ext) => ext.onStepStart);

    if (extensions.length === 0) return;

    const results = await Promise.allSettled(
      extensions.map(async (ext) => ext.onStepStart!()),
    );

    for (let i = 0; i < results.length; i++) {
      const settled = results[i]!;
      if (settled.status === 'rejected') {
        this.extensionDeps.logger.error(
          {
            error: settled.reason,
            extensionIdentifier: this.identifiersByExtension.get(
              extensions[i]!,
            ),
          },
          'Extension onStepStart hook failed',
        );
      }
    }
  }

  async start(): Promise<void> {
    for (const ext of this.extensions) {
      if (!ext.onStart) continue;
      await ext.onStart();
    }
  }

  async close(): Promise<void> {
    // Close in reverse factory order (LIFO) — mirrors resource cleanup.
    for (let i = this.extensions.length - 1; i >= 0; i--) {
      const ext = this.extensions[i]!;
      if (!ext.onClose) continue;
      try {
        await ext.onClose();
      } catch (error) {
        this.extensionDeps.logger.error(
          { error, extensionIdentifier: this.identifiersByExtension.get(ext) },
          'Extension onClose hook failed',
        );
      }
    }
  }

  getTools(model: ResolvedModel): ToolSet {
    const merged: Record<string, ToolSet[keyof ToolSet]> = {};

    for (const ext of this.extensions) {
      if (!ext.getTools) continue;
      const tools = ext.getTools(model);

      for (const [name, tool] of Object.entries(tools)) {
        if (merged[name]) {
          throw new Error(
            `Duplicate tool name "${name}" — tool names must be unique across all extensions.`,
          );
        }
        merged[name] = tool;
      }
    }

    return merged as ToolSet;
  }

  async runHistoryTransformers(
    history: ExtendedUIMessage[],
    model: ResolvedModel,
  ): Promise<{ history: ExtendedUIMessage[]; flags: TransformationFlags }> {
    let currentHistory = history;
    let flags: TransformationFlags = {};

    for (const ext of this.extensions) {
      if (!ext.historyTransformer) continue;
      try {
        const result = await ext.historyTransformer(currentHistory, model);
        const normalized = normalizeResult(result);
        currentHistory = normalized.history;
        flags = mergeFlags(flags, normalized.flags);
      } catch (error) {
        this.extensionDeps.logger.error(
          { error, extensionIdentifier: this.identifiersByExtension.get(ext) },
          'Extension historyTransformer failed — aborting transformation',
        );
        throw error;
      }
    }

    return { history: currentHistory, flags };
  }

  async runContextTransformers(
    history: ModelMessage[],
    model: ResolvedModel,
  ): Promise<{ history: ModelMessage[]; flags: TransformationFlags }> {
    let currentHistory = history;
    let flags: TransformationFlags = {};

    for (const ext of this.extensions) {
      if (!ext.contextTransformer) continue;
      try {
        const result = await ext.contextTransformer(currentHistory, model);
        const normalized = normalizeResult(result);
        currentHistory = normalized.history;
        flags = mergeFlags(flags, normalized.flags);
      } catch (error) {
        this.extensionDeps.logger.error(
          { error, extensionIdentifier: this.identifiersByExtension.get(ext) },
          'Extension contextTransformer failed — aborting transformation',
        );
        throw error;
      }
    }

    return { history: currentHistory, flags };
  }

  getDataPartTransformers(): DataPartTransformers {
    const merged: DataPartTransformers = {};

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

    return merged;
  }

  async runStepCompleteHooks(event: StepCompleteEvent): Promise<void> {
    const extensions = this.extensions.filter((ext) => ext.onStepComplete);

    if (extensions.length === 0) return;

    // Launch all hooks in parallel, each with its own structured clone
    // so mutations don't leak between extensions or back to the caller.
    // The async wrapper ensures synchronous throws become rejected promises
    // that Promise.allSettled can catch.
    //
    // Each hook is called on its extension instance (ext.onStepComplete!)
    // rather than extracting the method reference — this preserves the
    // `this` binding for class-based extensions that rely on instance state.
    const results = await Promise.allSettled(
      extensions.map(async (ext) =>
        ext.onStepComplete!(structuredClone(event)),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const settled = results[i]!;
      if (settled.status === 'rejected') {
        // Log the error but don't break — other hooks already ran in parallel.
        this.extensionDeps.logger.error(
          {
            error: settled.reason,
            extensionIdentifier: this.identifiersByExtension.get(
              extensions[i]!,
            ),
          },
          'Extension onStepComplete hook failed',
        );
      }
    }
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
    introspectionScope: deps.introspectionScope,
    onExtensionUsage: deps.onExtensionUsage,
  });
}

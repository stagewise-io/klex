import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extension-api';

/**
 * Maximum allowed length for the official name, in characters.
 * The name is truncated to this length after trimming, regardless
 * of what the config contains.
 */
const MAX_NAME_LENGTH = 128;

class NameLoaderExt implements Extension {
  /**
   * Resolves the official name from the config: trims whitespace
   * and truncates to {@link MAX_NAME_LENGTH} characters.
   *
   * Called once per step (via `getSystemPromptPart`) so config
   * changes are picked up without restarting the session.
   */
  private resolveName(): string {
    const raw = this.deps.config.get().officialName;
    return raw.trim().slice(0, MAX_NAME_LENGTH);
  }

  constructor(private readonly deps: ExtensionDeps) {}

  getSystemPromptPart(): string {
    return `Your name is ${this.resolveName()}.`;
  }

  introspect(): Record<string, unknown> {
    return { name: this.resolveName() };
  }
}

export const createNameLoaderExt: ExtensionFactory = {
  identifier: 'io.stagewise/name-loader',
  displayName: 'Name Loader',
  create: (deps) => new NameLoaderExt(deps),
};

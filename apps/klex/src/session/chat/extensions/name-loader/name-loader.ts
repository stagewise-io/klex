import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extension-api';

class NameLoaderExt implements Extension {
  /** Called once per step so config changes apply without a restart. */
  private resolveName(): string {
    return this.deps.config.get().officialName;
  }

  constructor(private readonly deps: ExtensionDeps) {}

  getSystemPromptPart(): string {
    return `Your official name is ${JSON.stringify(this.resolveName())}.`;
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

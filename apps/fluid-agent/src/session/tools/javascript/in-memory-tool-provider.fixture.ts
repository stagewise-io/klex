import type {
  JsonObject,
  JsonValue,
  ToolDescription,
  ToolProvider,
  ToolReference,
  ToolRequestContext,
  ToolSearchOptions,
  ToolSearchResult,
  ToolSnapshot,
} from '@/tool-provider';

const TOOLS = [
  { namespace: 'git.hub', name: 'echo-value', description: 'Echoes its input' },
  {
    namespace: 'git.hub',
    name: 'same',
    description: 'Returns its exact identity',
  },
  {
    namespace: 'git.hub',
    name: 'wait',
    description: 'Resolves asynchronously',
  },
  {
    namespace: 'other',
    name: 'same',
    description: 'Returns its exact identity',
  },
  {
    namespace: 'odd namespace',
    name: 'slash/name',
    description: 'Requires bracket notation',
  },
  {
    namespace: 'stale.namespace',
    name: 'temporary-tool',
    description: 'Can become stale',
  },
] as const;

export class InMemoryToolProvider implements ToolProvider {
  readonly invoked: ToolReference[] = [];
  readonly searches: { query: string; options: ToolSearchOptions }[] = [];
  readonly described: ToolReference[] = [];
  private readonly available = new Set(TOOLS.map(capabilityKey));
  private readonly expireAfterSnapshot = new Set<string>();

  async snapshot(_context: ToolRequestContext): Promise<ToolSnapshot> {
    const namespaces = new Map<string, { name: string }[]>();
    for (const capability of TOOLS) {
      if (!this.available.has(capabilityKey(capability))) continue;
      const capabilities = namespaces.get(capability.namespace) ?? [];
      capabilities.push({ name: capability.name });
      namespaces.set(capability.namespace, capabilities);
    }
    const snapshot = {
      namespaces: [...namespaces].map(([name, capabilities]) => ({
        name,
        capabilities,
      })),
    };
    for (const key of this.expireAfterSnapshot) this.available.delete(key);
    this.expireAfterSnapshot.clear();
    return snapshot;
  }

  async search(
    query: string,
    options: ToolSearchOptions,
    _context: ToolRequestContext,
  ): Promise<ToolSearchResult[]> {
    this.searches.push({ query, options });
    const normalizedQuery = query.toLowerCase();
    return TOOLS.filter(
      (capability) =>
        this.available.has(capabilityKey(capability)) &&
        `${capability.namespace} ${capability.name} ${capability.description}`
          .toLowerCase()
          .includes(normalizedQuery),
    )
      .slice(0, options.limit)
      .map((capability) => ({
        reference: { namespace: capability.namespace, name: capability.name },
        description: capability.description,
      }));
  }

  async describe(
    reference: ToolReference,
    _context: ToolRequestContext,
  ): Promise<ToolDescription> {
    this.described.push(reference);
    const capability = this.requireCapability(reference);
    return { reference, description: capability.description };
  }

  async invoke(
    reference: ToolReference,
    input: JsonObject,
    context: ToolRequestContext,
  ): Promise<JsonValue> {
    this.requireCapability(reference);
    this.invoked.push(reference);
    if (reference.name === 'wait') await abortableDelay(10, context.signal);
    if (reference.name === 'same') {
      return {
        reference: { namespace: reference.namespace, name: reference.name },
        input,
      };
    }
    return input;
  }

  expireFromNextSnapshot(reference: ToolReference): void {
    this.expireAfterSnapshot.add(capabilityKey(reference));
  }

  remove(reference: ToolReference): void {
    this.available.delete(capabilityKey(reference));
  }

  private requireCapability(reference: ToolReference) {
    const capability = TOOLS.find(
      (candidate) =>
        candidate.namespace === reference.namespace &&
        candidate.name === reference.name,
    );
    if (!capability || !this.available.has(capabilityKey(reference))) {
      throw new Error(
        `Tool is unavailable: ${reference.namespace}/${reference.name}`,
      );
    }
    return capability;
  }
}

function capabilityKey(reference: ToolReference): string {
  return JSON.stringify([reference.namespace, reference.name]);
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

import type { JsonObject, JsonValue } from './serialization';
import type {
  CapabilityDescription,
  CapabilityProvider,
  CapabilityReference,
  CapabilityRequestContext,
  CapabilitySearchOptions,
  CapabilitySearchResult,
  CapabilitySnapshot,
} from './toolbox';

const CAPABILITIES = [
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

export class InMemoryCapabilityProvider implements CapabilityProvider {
  readonly invoked: CapabilityReference[] = [];
  readonly searches: { query: string; options: CapabilitySearchOptions }[] = [];
  readonly described: CapabilityReference[] = [];
  private readonly available = new Set(CAPABILITIES.map(capabilityKey));
  private readonly expireAfterSnapshot = new Set<string>();

  async snapshot(
    _context: CapabilityRequestContext,
  ): Promise<CapabilitySnapshot> {
    const namespaces = new Map<string, { name: string }[]>();
    for (const capability of CAPABILITIES) {
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
    options: CapabilitySearchOptions,
    _context: CapabilityRequestContext,
  ): Promise<CapabilitySearchResult[]> {
    this.searches.push({ query, options });
    const normalizedQuery = query.toLowerCase();
    return CAPABILITIES.filter(
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
    reference: CapabilityReference,
    _context: CapabilityRequestContext,
  ): Promise<CapabilityDescription> {
    this.described.push(reference);
    const capability = this.requireCapability(reference);
    return { reference, description: capability.description };
  }

  async invoke(
    reference: CapabilityReference,
    input: JsonObject,
    context: CapabilityRequestContext,
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

  expireFromNextSnapshot(reference: CapabilityReference): void {
    this.expireAfterSnapshot.add(capabilityKey(reference));
  }

  remove(reference: CapabilityReference): void {
    this.available.delete(capabilityKey(reference));
  }

  private requireCapability(reference: CapabilityReference) {
    const capability = CAPABILITIES.find(
      (candidate) =>
        candidate.namespace === reference.namespace &&
        candidate.name === reference.name,
    );
    if (!capability || !this.available.has(capabilityKey(reference))) {
      throw new Error(
        `Capability is unavailable: ${reference.namespace}/${reference.name}`,
      );
    }
    return capability;
  }
}

function capabilityKey(reference: CapabilityReference): string {
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

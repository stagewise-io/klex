export const MACHINE_CATALOG_VERSION = '1';
/** Must match the Cloud limit for one serialized catalog snapshot. */
export const MACHINE_CATALOG_MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 256;
const MAX_PAGES = 16;
const PROTOCOL_VERSION = '2025-06-18';

export interface MachineCatalog {
  version: typeof MACHINE_CATALOG_VERSION;
  daemonVersion: string;
  workloadReporting: boolean;
  capabilities: Record<string, unknown>;
  tools: Record<string, unknown>[];
  resources: Record<string, unknown>[];
  resourceTemplates: Record<string, unknown>[];
}

export interface CatalogSource {
  fetch(request: Request): Promise<Response>;
}

export class MachineCatalogError extends Error {}

/**
 * Describe an MCP handler by asking it, so the published catalog is exactly
 * what agents would see from a live `tools/list`.
 */
export async function describeMachineCatalog(
  source: CatalogSource,
  options: { daemonVersion: string; workloadReporting: boolean },
): Promise<MachineCatalog> {
  const initialized = await rpc(source, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: 'klex-machine-catalog',
      version: options.daemonVersion,
    },
  });
  const capabilities = record(initialized.capabilities) ?? {};
  const tools = await list(source, 'tools/list', 'tools');
  const resources = capabilities.resources
    ? await list(source, 'resources/list', 'resources')
    : [];
  const resourceTemplates = capabilities.resources
    ? await list(source, 'resources/templates/list', 'resourceTemplates')
    : [];
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length)
    throw new MachineCatalogError('Machine MCP reports duplicate tool names');
  const catalog: MachineCatalog = {
    version: MACHINE_CATALOG_VERSION,
    daemonVersion: options.daemonVersion,
    workloadReporting: options.workloadReporting,
    capabilities,
    tools,
    resources,
    resourceTemplates,
  };
  if (catalogByteLength(catalog) > MACHINE_CATALOG_MAX_BYTES)
    throw new MachineCatalogError('Machine catalog exceeds the size limit');
  return catalog;
}

export function catalogByteLength(catalog: MachineCatalog): number {
  return Buffer.byteLength(JSON.stringify(catalog), 'utf8');
}

async function list(
  source: CatalogSource,
  method: string,
  key: string,
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await rpc(source, method, cursor ? { cursor } : {});
    const items = result[key];
    if (!Array.isArray(items))
      throw new MachineCatalogError(`${method} returned no ${key}`);
    for (const item of items) {
      const entry = record(item);
      if (!entry) throw new MachineCatalogError(`${method} returned bad entry`);
      entries.push(entry);
    }
    if (entries.length > MAX_ENTRIES)
      throw new MachineCatalogError(`${method} exceeds ${MAX_ENTRIES} entries`);
    cursor =
      typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
    if (!cursor) return entries;
  }
  throw new MachineCatalogError(`${method} pagination did not terminate`);
}

async function rpc(
  source: CatalogSource,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await source.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  const text = await response.text();
  if (!response.ok)
    throw new MachineCatalogError(`${method} failed with ${response.status}`);
  const body = response.headers
    .get('content-type')
    ?.includes('text/event-stream')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6)
    : text;
  let message: unknown;
  try {
    message = JSON.parse(body ?? '');
  } catch {
    throw new MachineCatalogError(`${method} returned malformed JSON`);
  }
  const result = record(record(message)?.result);
  if (!result) throw new MachineCatalogError(`${method} returned no result`);
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

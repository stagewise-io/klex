import type {
  Tool as McpToolDefinition,
  Resource,
  ResourceTemplateType,
} from '@modelcontextprotocol/client';
import { z } from 'zod';

/**
 * Set on the MCP `initialize` POST of a connection opened for real work. The
 * proxy rejects it on any other method, and on later POSTs it would count
 * discovery traffic as activity, so it never leaves the initialization.
 */
export const MACHINE_DEMAND_HEADER = 'x-klex-machine-demand';
const MACHINE_DEMAND_INVOCATION = 'invocation';

/** The catalog is a durable control-plane record; it never needs long. */
export const MCP_CATALOG_TIMEOUT_MS = 15_000;
/** Catalogs are capped at 256 KiB upstream; leave headroom for the envelope. */
const MCP_CATALOG_MAX_BYTES = 1024 * 1024;
const MCP_CATALOG_ENVELOPE_VERSION = 1;
const MCP_CATALOG_VERSION = '1';
const MAX_CATALOG_ENTRIES = 256;

export type McpCatalogFailure =
  /** The token was rejected after discovery. */
  | 'unauthorized'
  /** The agent is no longer assigned to the server. */
  | 'forbidden'
  /** The server no longer exists. */
  | 'not_found'
  /** Transport failure or server error; retry later. */
  | 'unavailable'
  /** The response broke the catalog contract. */
  | 'malformed';

export class McpCatalogError extends Error {
  public constructor(
    readonly reason: McpCatalogFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'McpCatalogError';
  }

  /** Whether retained descriptors must be discarded. */
  get revokesDescriptors(): boolean {
    return this.reason !== 'unavailable';
  }
}

export interface McpCatalogSnapshot {
  /** Provider generation the descriptors belong to. */
  readonly generation: number;
  readonly tools: readonly McpToolDefinition[];
  readonly resources: readonly Resource[];
  readonly resourceTemplates: readonly ResourceTemplateType[];
}

export type McpCatalogResult =
  | { readonly status: 'ready'; readonly snapshot: McpCatalogSnapshot }
  /**
   * No descriptors for the current generation (`missing`, `stale`,
   * `incompatible`, or a status this build does not know). The server cannot
   * be listed without a live connection.
   */
  | { readonly status: 'unavailable'; readonly catalogStatus: string };

const toolSchemaSchema = z.looseObject({
  type: z.literal('object'),
  properties: z.record(z.string(), z.json()).optional(),
  required: z.array(z.string()).optional(),
});

const catalogToolSchema = z.object({
  name: z.string().min(1).max(128),
  title: z.string().max(1024).optional(),
  description: z.string().max(16_384).optional(),
  inputSchema: toolSchemaSchema,
  outputSchema: toolSchemaSchema.optional(),
  annotations: z
    .object({
      title: z.string().max(1024).optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
});

const catalogResourceSchema = z.object({
  uri: z.string().min(1).max(4096),
  name: z.string().min(1).max(256),
  title: z.string().max(1024).optional(),
  description: z.string().max(16_384).optional(),
  mimeType: z.string().max(256).optional(),
});

const catalogResourceTemplateSchema = z.object({
  uriTemplate: z.string().min(1).max(4096),
  name: z.string().min(1).max(256),
  title: z.string().max(1024).optional(),
  description: z.string().max(16_384).optional(),
  mimeType: z.string().max(256).optional(),
});

const catalogEnvelopeSchema = z.object({
  version: z.literal(MCP_CATALOG_ENVELOPE_VERSION),
  generation: z.number().int().nonnegative(),
  catalogStatus: z.string().min(1).max(64),
  catalog: z.unknown(),
});

const catalogSchema = z.object({
  version: z.literal(MCP_CATALOG_VERSION),
  tools: z
    .array(catalogToolSchema)
    .max(MAX_CATALOG_ENTRIES)
    .refine(
      (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
      'Duplicate tool names',
    ),
  resources: z
    .array(catalogResourceSchema)
    .max(MAX_CATALOG_ENTRIES)
    .default([]),
  resourceTemplates: z
    .array(catalogResourceTemplateSchema)
    .max(MAX_CATALOG_ENTRIES)
    .default([]),
});

/**
 * Reads the no-wake catalog. `fetchImpl` carries the server's credentials and
 * must only reach the catalog URL; config admission enforces the shared origin.
 */
export async function fetchMcpCatalog(options: {
  catalogUrl: string;
  fetch: typeof fetch;
  signal: AbortSignal;
}): Promise<McpCatalogResult> {
  let response: Response;
  try {
    response = await options.fetch(options.catalogUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: options.signal,
    });
  } catch (error) {
    throw new McpCatalogError('unavailable', 'MCP catalog request failed', {
      cause: error,
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw catalogStatusError(response.status);
  }
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MCP_CATALOG_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new McpCatalogError('malformed', 'MCP catalog is too large');
  }
  let body: unknown;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MCP_CATALOG_MAX_BYTES)
      throw new McpCatalogError('malformed', 'MCP catalog is too large');
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof McpCatalogError) throw error;
    throw new McpCatalogError('malformed', 'MCP catalog is not valid JSON', {
      cause: error,
    });
  }
  return parseMcpCatalog(body);
}

export function parseMcpCatalog(body: unknown): McpCatalogResult {
  const envelope = catalogEnvelopeSchema.safeParse(body);
  if (!envelope.success)
    throw new McpCatalogError(
      'malformed',
      'MCP catalog response has an unsupported shape',
      { cause: envelope.error },
    );
  if (envelope.data.catalogStatus !== 'ready')
    return {
      status: 'unavailable',
      catalogStatus: envelope.data.catalogStatus,
    };
  const catalog = catalogSchema.safeParse(envelope.data.catalog);
  // A ready catalog in a version this build cannot read is not an error of
  // the server; it only has no descriptors this agent can use.
  if (!catalog.success)
    return { status: 'unavailable', catalogStatus: 'incompatible' };
  return {
    status: 'ready',
    snapshot: {
      generation: envelope.data.generation,
      tools: catalog.data.tools,
      resources: catalog.data.resources,
      resourceTemplates: catalog.data.resourceTemplates,
    },
  };
}

function catalogStatusError(status: number): McpCatalogError {
  if (status === 401)
    return new McpCatalogError(
      'unauthorized',
      'MCP catalog rejected the token',
    );
  if (status === 403)
    return new McpCatalogError(
      'forbidden',
      'Agent is not authorized for this MCP server',
    );
  if (status === 404)
    return new McpCatalogError('not_found', 'MCP server no longer exists');
  return new McpCatalogError(
    'unavailable',
    `MCP catalog request failed with HTTP ${status}`,
  );
}

/**
 * Marks only the MCP initialization as demand. Must wrap the fetch the
 * transport calls directly, before any authentication layer rebuilds the
 * request.
 */
export function withMachineDemand(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (!(await isInitializeRequest(input, init)))
      return fetchImpl(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(MACHINE_DEMAND_HEADER, MACHINE_DEMAND_INVOCATION);
    return fetchImpl(input, { ...init, headers });
  };
}

async function isInitializeRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<boolean> {
  const method = (
    init?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  if (method !== 'POST') return false;
  let body: string | undefined;
  if (typeof init?.body === 'string') body = init.body;
  else if (init?.body == null && input instanceof Request && input.body)
    body = await input.clone().text();
  if (body === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'method' in message &&
        message.method === 'initialize',
    );
  } catch {
    return false;
  }
}

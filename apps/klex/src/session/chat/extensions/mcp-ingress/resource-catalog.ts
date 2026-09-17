import type {
  Resource,
  ResourceTemplateType,
} from '@modelcontextprotocol/client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESOURCE_CATALOG_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResourceCatalog = {
  resources: Resource[];
  resourceTemplates: ResourceTemplateType[];
};

export type ResourceCatalogEntry =
  | { type: 'resource'; resource: Resource }
  | { type: 'template'; template: ResourceTemplateType };

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Parses a 1-based cursor string. Returns 1 when undefined or empty. */
export function parseCatalogCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 1;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `Invalid resource catalog cursor: ${JSON.stringify(cursor)}`,
    );
  }
  return value;
}

/** Pages a catalog, returning entries, total count, and optional next cursor. */
export function pageResourceCatalog(
  catalog: ResourceCatalog,
  cursor: number,
): {
  entries: ResourceCatalogEntry[];
  totalEntries: number;
  nextCursor?: string;
} {
  const entries: ResourceCatalogEntry[] = [
    ...catalog.resources.map((resource) => ({
      type: 'resource' as const,
      resource,
    })),
    ...catalog.resourceTemplates.map((template) => ({
      type: 'template' as const,
      template,
    })),
  ];
  entries.sort(compareResourceCatalogEntries);

  // cursor is 1-based; convert to 0-based slice index
  const startIdx = cursor - 1;
  const page = entries.slice(startIdx, startIdx + RESOURCE_CATALOG_PAGE_SIZE);
  const endIdx = startIdx + page.length;
  return {
    entries: page,
    totalEntries: entries.length,
    ...(endIdx < entries.length ? { nextCursor: String(endIdx + 1) } : {}),
  };
}

function compareResourceCatalogEntries(
  a: ResourceCatalogEntry,
  b: ResourceCatalogEntry,
): number {
  const aName = a.type === 'resource' ? a.resource.name : a.template.name;
  const bName = b.type === 'resource' ? b.resource.name : b.template.name;
  const nameComparison = aName.localeCompare(bName, 'en', {
    sensitivity: 'base',
  });
  if (nameComparison !== 0) return nameComparison;

  const aIdentifier =
    a.type === 'resource' ? a.resource.uri : a.template.uriTemplate;
  const bIdentifier =
    b.type === 'resource' ? b.resource.uri : b.template.uriTemplate;
  const identifierComparison = aIdentifier.localeCompare(bIdentifier, 'en');
  if (identifierComparison !== 0) return identifierComparison;
  return a.type.localeCompare(b.type, 'en');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Formats a paged catalog as a pipe-delimited table with a showing-range footer. */
export function formatResourceList(
  serverName: string,
  result: {
    entries: ResourceCatalogEntry[];
    totalEntries: number;
    nextCursor?: string;
  },
): string {
  const { entries, totalEntries, nextCursor } = result;

  if (totalEntries === 0) {
    return `No resources or resource templates available on server '${serverName}'.`;
  }

  const nextCursorNum =
    nextCursor !== undefined ? Number(nextCursor) : totalEntries + 1;
  const start = nextCursorNum - entries.length;
  const end = start + entries.length - 1;

  const lines = ['name|uri|mime|description'];
  for (const entry of entries) lines.push(formatResourceCatalogEntry(entry));
  lines.push(`Showing ${start}-${end}/${totalEntries}`);
  return lines.join('\n');
}

function formatResourceCatalogEntry(entry: ResourceCatalogEntry): string {
  if (entry.type === 'resource') {
    const { name, uri, mimeType, description } = entry.resource;
    return [
      formatCatalogTextCell(name),
      formatCatalogTextCell(uri),
      formatCatalogTextCell(mimeType),
      formatCatalogTextCell(description),
    ].join('|');
  }

  const { name, uriTemplate, mimeType, description } = entry.template;
  return [
    formatCatalogTextCell(name),
    formatCatalogTextCell(uriTemplate),
    formatCatalogTextCell(mimeType),
    formatCatalogTextCell(description),
  ].join('|');
}

/** Detects unexpanded `{variable}` expressions in a URI template. */
export function hasUnexpandedUriTemplateExpression(uri: string): boolean {
  return /\{[^{}]+\}/u.test(uri);
}

function formatCatalogTextCell(value: string | undefined): string {
  return (value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

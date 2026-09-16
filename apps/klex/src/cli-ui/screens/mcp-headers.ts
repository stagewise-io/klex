export interface HttpHeaderEntry {
  key: string;
  value: string;
}

export interface HttpMcpFormConfig {
  type: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
}

export function validateHttpMcpUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('URL is required');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL must be an absolute HTTP or HTTPS URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must use HTTP or HTTPS');
  }

  return value;
}

export function buildHttpMcpFormConfig(
  url: string,
  headers?: Record<string, string>,
): HttpMcpFormConfig {
  return {
    type: 'streamable-http',
    url: validateHttpMcpUrl(url),
    ...(headers ? { headers } : {}),
  };
}

export function parseHeaders(
  input: string,
): Record<string, string> | undefined {
  const value = input.trim();
  if (!value) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Headers must be valid JSON');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((headerValue) => typeof headerValue !== 'string')
  ) {
    throw new Error('Headers must be a JSON object with string values');
  }

  return parsed as Record<string, string>;
}

export function buildHeaderUpdates(
  previousKey: string | undefined,
  nextKey: string,
  nextValue: string,
): Record<string, string | null> {
  const updates: Record<string, string | null> = { [nextKey]: nextValue };
  if (previousKey && previousKey.toLowerCase() !== nextKey.toLowerCase()) {
    updates[previousKey] = null;
  }
  return updates;
}

export function headersFromEntries(
  entries: HttpHeaderEntry[],
): Record<string, string> | undefined {
  if (entries.length === 0) return undefined;

  const headers: Record<string, string> = {};
  const normalizedKeys = new Set<string>();
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) throw new Error('Header name is required');

    const normalizedKey = key.toLowerCase();
    if (normalizedKeys.has(normalizedKey)) {
      throw new Error(`Header "${key}" is duplicated`);
    }

    normalizedKeys.add(normalizedKey);
    headers[key] = entry.value;
  }

  return headers;
}

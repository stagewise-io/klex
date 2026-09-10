import { describe, expect, it } from 'vitest';

import {
  buildHeaderUpdates,
  buildHttpMcpFormConfig,
  headersFromEntries,
  parseHeaders,
  validateHttpMcpUrl,
} from './mcp-headers';

describe('buildHttpMcpFormConfig', () => {
  it('builds the API-supported streamable HTTP shape', () => {
    const config = buildHttpMcpFormConfig(' https://mcp.example.com/mcp ', {
      Authorization: 'Bearer secret',
    });

    expect(config).toEqual({
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(config).not.toHaveProperty('transport');
  });

  it('omits headers when none are configured', () => {
    expect(buildHttpMcpFormConfig('http://localhost:3000/mcp')).toEqual({
      type: 'streamable-http',
      url: 'http://localhost:3000/mcp',
    });
  });
});

describe('validateHttpMcpUrl', () => {
  it('accepts absolute HTTP and HTTPS URLs', () => {
    expect(validateHttpMcpUrl('http://localhost:3000/mcp')).toBe(
      'http://localhost:3000/mcp',
    );
    expect(validateHttpMcpUrl(' https://mcp.example.com/path ')).toBe(
      'https://mcp.example.com/path',
    );
  });

  it('rejects empty and malformed URLs', () => {
    expect(() => validateHttpMcpUrl('')).toThrow('URL is required');
    expect(() => validateHttpMcpUrl('not a url')).toThrow(
      'URL must be an absolute HTTP or HTTPS URL',
    );
  });

  it('rejects unsupported URL schemes', () => {
    expect(() => validateHttpMcpUrl('ftp://example.com/mcp')).toThrow(
      'URL must use HTTP or HTTPS',
    );
  });
});

describe('buildHeaderUpdates', () => {
  it('updates a value without deleting a differently-cased equivalent key', () => {
    expect(
      buildHeaderUpdates('Authorization', 'authorization', 'Bearer new'),
    ).toEqual({ authorization: 'Bearer new' });
  });

  it('deletes the old key when a header is genuinely renamed', () => {
    expect(buildHeaderUpdates('X-Old', 'X-New', 'value')).toEqual({
      'X-New': 'value',
      'X-Old': null,
    });
  });
});

describe('headersFromEntries', () => {
  it('builds headers from key-value rows', () => {
    expect(
      headersFromEntries([
        { key: 'Authorization', value: 'Bearer secret' },
        { key: ' X-Tenant ', value: 'acme' },
      ]),
    ).toEqual({ Authorization: 'Bearer secret', 'X-Tenant': 'acme' });
  });

  it('returns undefined when the list is empty', () => {
    expect(headersFromEntries([])).toBeUndefined();
  });

  it('rejects empty and case-insensitively duplicated names', () => {
    expect(() => headersFromEntries([{ key: ' ', value: 'secret' }])).toThrow(
      'Header name is required',
    );
    expect(() =>
      headersFromEntries([
        { key: 'Authorization', value: 'one' },
        { key: 'authorization', value: 'two' },
      ]),
    ).toThrow('Header "authorization" is duplicated');
  });
});

describe('parseHeaders', () => {
  it('returns undefined for omitted headers', () => {
    expect(parseHeaders('')).toBeUndefined();
    expect(parseHeaders('  ')).toBeUndefined();
  });

  it('parses a JSON object with string values', () => {
    expect(
      parseHeaders('{"Authorization":"Bearer secret","X-Tenant":"acme"}'),
    ).toEqual({
      Authorization: 'Bearer secret',
      'X-Tenant': 'acme',
    });
  });

  it('rejects non-string header values', () => {
    expect(() => parseHeaders('{"X-Retries":3}')).toThrow(
      'Headers must be a JSON object with string values',
    );
  });

  it('rejects arrays', () => {
    expect(() => parseHeaders('["Authorization"]')).toThrow(
      'Headers must be a JSON object with string values',
    );
  });

  it('rejects malformed JSON', () => {
    expect(() => parseHeaders('{invalid')).toThrow(
      'Headers must be valid JSON',
    );
  });
});

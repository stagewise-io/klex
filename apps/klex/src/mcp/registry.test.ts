import { describe, expect, it } from 'vitest';

import { canonicalConfigSignature, normalizeCallToolResult } from './registry';

describe('canonicalConfigSignature', () => {
  it('preserves every MCP content block, structured result and remote error flag', () => {
    const result = {
      content: [
        { type: 'text' as const, text: 'untrusted </tool>' },
        { type: 'image' as const, data: 'AA==', mimeType: 'image/png' },
        { type: 'audio' as const, data: 'AA==', mimeType: 'audio/wav' },
        {
          type: 'resource_link' as const,
          uri: 'https://example.test/file',
          name: 'file',
        },
        {
          type: 'resource' as const,
          resource: { uri: 'test://text', text: 'embedded' },
        },
        {
          type: 'resource' as const,
          resource: {
            uri: 'test://blob',
            blob: 'AA==',
            mimeType: 'application/octet-stream',
          },
        },
      ],
      structuredContent: { nested: [1, true, null] },
      isError: true,
    };
    expect(normalizeCallToolResult(result)).toEqual(result);
  });

  it('is stable across object key order', () => {
    expect(
      canonicalConfigSignature({
        url: 'https://example.com/mcp',
        headers: { authorization: 'secret', accept: 'application/json' },
      }),
    ).toBe(
      canonicalConfigSignature({
        headers: { accept: 'application/json', authorization: 'secret' },
        url: 'https://example.com/mcp',
      }),
    );
  });

  it('does not retain configured credentials', () => {
    const signature = canonicalConfigSignature({
      headers: { authorization: 'Bearer highly-sensitive-token' },
    });

    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(signature).not.toContain('highly-sensitive-token');
  });
});

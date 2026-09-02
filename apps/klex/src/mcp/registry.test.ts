import { describe, expect, it } from 'vitest';

import { canonicalConfigSignature } from './registry';

describe('canonicalConfigSignature', () => {
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

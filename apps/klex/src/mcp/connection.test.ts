import { describe, expect, it } from 'vitest';

import {
  resolveVersionNegotiation,
  shouldUseAutomaticOAuth,
} from './connection';

describe('MCP connection version negotiation', () => {
  it('defaults omitted policy to automatic negotiation', () => {
    expect(
      resolveVersionNegotiation({ url: 'https://example.com/mcp' }),
    ).toEqual({ mode: 'auto' });
  });

  it('passes through legacy negotiation', () => {
    expect(
      resolveVersionNegotiation({
        command: 'mcp-server',
        versionNegotiation: 'legacy',
      }),
    ).toEqual({ mode: 'legacy' });
  });

  it('passes through pinned negotiation', () => {
    expect(
      resolveVersionNegotiation({
        url: 'https://example.com/mcp',
        versionNegotiation: { pin: '2026-07-28' },
      }),
    ).toEqual({ mode: { pin: '2026-07-28' } });
  });
});

describe('MCP OAuth detection', () => {
  it('enables OAuth negotiation for a URL-only HTTP configuration', () => {
    expect(shouldUseAutomaticOAuth({ url: 'https://example.com/mcp' })).toBe(
      true,
    );
  });

  it('accepts a Claude-compatible explicit HTTP transport type', () => {
    expect(
      shouldUseAutomaticOAuth({
        type: 'http',
        url: 'https://example.com/mcp',
      }),
    ).toBe(true);
  });

  it('lets an explicit Authorization header take precedence', () => {
    expect(
      shouldUseAutomaticOAuth({
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      }),
    ).toBe(false);
  });

  it('does not use HTTP OAuth for stdio servers', () => {
    expect(shouldUseAutomaticOAuth({ command: 'mcp-server' })).toBe(false);
  });
});

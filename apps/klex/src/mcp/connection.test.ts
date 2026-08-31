import { describe, expect, it, vi } from 'vitest';

import {
  type CloudAuthProvider,
  createTransport,
  resolveVersionNegotiation,
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

describe('createTransport cloud auth', () => {
  it('creates an HTTP transport without Cloud auth when useCloudAuth is false', () => {
    const transport = createTransport({
      url: 'https://example.com/mcp',
    });
    expect(transport).toBeDefined();
  });

  it('creates an HTTP transport with discovery auth when useCloudAuth is true', () => {
    const cloudAuth: CloudAuthProvider = {
      getAccessToken: vi.fn(async () => 'test-token'),
      invalidate: vi.fn(),
      isTrustedAuthorizationServer: vi.fn(() => true),
    };
    const transport = createTransport(
      { url: 'https://example.com/mcp', useCloudAuth: true },
      cloudAuth,
    );
    expect(transport).toBeDefined();
  });
});

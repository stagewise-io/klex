import { describe, expect, it } from 'vitest';

import { resolveVersionNegotiation } from './connection';

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

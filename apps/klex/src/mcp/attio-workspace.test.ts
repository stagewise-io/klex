import { describe, expect, it } from 'vitest';

import { isAttioServer, parseAttioWorkspace } from './attio-workspace';

describe('Attio workspace metadata', () => {
  it('reads workspace identity without exposing member identity', () => {
    expect(
      parseAttioWorkspace({
        content: [
          {
            type: 'text',
            text: 'email: private@example.com\nname: A member\nworkspace_slug: example\nworkspace_name: "Example: CRM"\nteams[0]:',
          },
        ],
      }),
    ).toEqual({ name: 'Example: CRM', slug: 'example' });
  });
  it('accepts structured output and rejects missing or invalid workspace identity', () => {
    expect(
      parseAttioWorkspace({
        content: [],
        structuredContent: {
          workspace_name: 'Example',
          workspace_slug: 'example',
        },
      }),
    ).toEqual({ name: 'Example', slug: 'example' });
    expect(
      parseAttioWorkspace({
        content: [
          { type: 'text', text: 'name: Member\nworkspace_slug: ../other' },
        ],
      }),
    ).toBeUndefined();
    expect(
      parseAttioWorkspace({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'workspace_name: Example\nworkspace_slug: example',
          },
        ],
      }),
    ).toBeUndefined();
  });
  it('only discovers metadata for the official Attio endpoint', () => {
    expect(isAttioServer({ url: 'https://mcp.attio.com/mcp' })).toBe(true);
    expect(isAttioServer({ url: 'https://example.com/mcp' })).toBe(false);
    expect(isAttioServer({ command: 'attio' })).toBe(false);
  });
});

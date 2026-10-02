import { describe, expect, it, vi } from 'vitest';

import { collectEpisodicHistory } from '@/session/chat/extensions/memory/history-compression';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { redactAttachmentSecrets } from './attachment-privacy';

vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: 'Time.',
}));

describe('attachment privacy', () => {
  it('removes URLs and media from debug projections without mutating input', () => {
    const value = [
      {
        type: 'tool-call',
        toolName: 'readAttachment',
        input: { url: 'https://example.com/private-path?signature=secret' },
      },
      { type: 'image-data', data: 'PRIVATE_BYTES', mediaType: 'image/png' },
      {
        type: 'resource_link',
        uri: 'https://example.com/signed-path',
        name: 'photo',
      },
    ];
    const serialized = JSON.stringify(redactAttachmentSecrets(value));
    expect(serialized).not.toContain('PRIVATE_BYTES');
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('secret');
    expect(value[1]).toHaveProperty('data', 'PRIVATE_BYTES');
  });
  it('does not persist signed links through episodic memory', () => {
    const history: ExtendedUIMessage[] = [
      {
        id: '1',
        role: 'user',
        parts: [
          {
            type: 'data-context',
            data: {
              sourceEnv: 'connector',
              metadata: {},
              content: [
                {
                  type: 'resource_link',
                  uri: 'https://example.com/a?signature=secret',
                  name: 'photo',
                },
              ],
            },
          },
        ],
      },
      {
        id: '2',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'readAttachment',
            toolCallId: 'c',
            state: 'output-available',
            input: { url: 'https://example.com/a?signature=secret' },
            output: { ok: true },
          },
        ],
      },
    ];
    const result = JSON.stringify(collectEpisodicHistory(history, null));
    expect(result).not.toContain('https://');
    expect(result).not.toContain('signature');
    expect(result).toContain('readAttachment');
  });
});

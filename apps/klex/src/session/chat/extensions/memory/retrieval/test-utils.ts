import { vi } from 'vitest';

import type { ChildSessionHandle } from '@/session/types';

export function makeChildSessionFixture(
  sessionId = 'retrieval-child',
): ChildSessionHandle {
  const info = {
    name: 'memory-retrieval',
    kind: 'child' as const,
    parentId: null,
    modelPurpose: 'memory' as const,
    id: sessionId,
    status: 'active' as const,
    runtimeState: 'idle' as const,
    model: { id: null, isFallback: false, fallbackIndex: 0 },
    usage: {
      chat: {
        latest: null,
        total: {
          inputTokens: 0,
          outputTokens: 0,
          inputCacheWriteTokens: 0,
          inputCacheReadTokens: 0,
        },
      },
      extensions: {},
    },
    turns: 0,
    steps: 0,
    messageCount: 0,
    createdAt: new Date().toISOString(),
  };
  return {
    sessionId,
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    getMessages: vi.fn(() => []),
    getSessionInfo: vi.fn(() => info),
    close: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => true),
    createChildSession: vi.fn(async () => {
      throw new Error('fixture child cannot create children');
    }),
  };
}

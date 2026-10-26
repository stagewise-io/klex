import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import { SessionInboxUrgency } from '@/session/inbox';
import type { SessionHistory, SessionHistoryRecorder } from '@/session-history';

import { createChatSession } from './chat-session';
import { createTurn, type TurnResult } from './turn';
import { BackoffManager } from './utils/backoff-manager';

vi.mock('./turn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./turn')>()),
  createTurn: vi.fn(),
}));

const success: TurnResult = {
  fatalError: false,
  fatalErrorReason: null,
  completeFailure: false,
  requestRejected: false,
  stopReason: 'completed',
  stepCount: 1,
  usage: null,
  failureReason: null,
  failedModelId: null,
};

describe('ChatSession model health', () => {
  it.each(['turn_failed', 'request_rejected', 'terminated'] as const)(
    'records %s and clears on recovery',
    async (kind) => {
      const recorder: SessionHistoryRecorder = {
        instanceId: 'test',
        scheduleSync: vi.fn(),
        seed: vi.fn(),
        markTrimmed: vi.fn(),
        commitCheckpoint: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        recordHealthFailure: vi.fn(),
        clearHealthFailure: vi.fn(),
      };
      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
      };
      const scope: IntrospectionScope = {
        path: [],
        introspect: vi.fn(),
        child: vi.fn(() => scope),
        removeChild: vi.fn(),
      };
      const failure: TurnResult = {
        ...success,
        completeFailure: true,
        fatalError: kind === 'terminated',
        requestRejected: kind === 'request_rejected',
        failureReason: 'classified error',
        failedModelId: 'work:model-a',
      };
      const run = vi
        .fn()
        .mockResolvedValueOnce(failure)
        .mockResolvedValue(success);
      if (kind === 'turn_failed') run.mockResolvedValueOnce(failure);
      const delay = vi
        .spyOn(BackoffManager.prototype, 'getDelay')
        .mockReturnValue(0);
      vi.mocked(createTurn).mockReturnValue({
        run,
        abortGeneration: vi.fn(),
        abortTools: vi.fn(),
      } as unknown as ReturnType<typeof createTurn>);
      const session = createChatSession({
        logging: { child: () => logger } as unknown as RootLogger,
        config: {
          get: () => ({
            modelSelection: {
              chat: [{ providerId: 'work', modelId: 'model-a' }],
            },
          }),
        } as unknown as Config,
        modelResolver: { resolveModelInfo: () => undefined } as never,
        dataDirectory: '/tmp/klex-health-test',
        mcp: null,
        extensionFactories: [],
        introspectionScope: scope,
        sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
        basePrompt: '',
        sessionHistory: {
          openRecorder: () => recorder,
        } as unknown as SessionHistory,
      });
      try {
        await session.start();
        session.inbox.sendMessage(
          {
            id: 'first',
            role: 'user',
            parts: [{ type: 'text', text: 'hello' }],
          },
          SessionInboxUrgency.Default,
        );
        await vi.waitFor(() =>
          expect(recorder.recordHealthFailure).toHaveBeenCalledWith({
            kind,
            reason: 'classified error',
            modelId: 'work:model-a',
            consecutiveFailures: 1,
            occurredAt: expect.any(String),
          }),
        );
        if (kind === 'terminated') {
          await vi.waitFor(() =>
            expect(recorder.end).toHaveBeenCalledWith('fatal_error'),
          );
          expect(recorder.clearHealthFailure).not.toHaveBeenCalled();
          expect(
            vi.mocked(recorder.recordHealthFailure).mock.invocationCallOrder[0],
          ).toBeLessThan(
            vi.mocked(recorder.end).mock.invocationCallOrder[0] ?? 0,
          );
        } else {
          if (kind === 'request_rejected') {
            await session.waitForIdle(1000);
            session.inbox.sendMessage(
              {
                id: 'next',
                role: 'user',
                parts: [{ type: 'text', text: 'retry' }],
              },
              SessionInboxUrgency.Default,
            );
          }
          await vi.waitFor(
            () => expect(recorder.clearHealthFailure).toHaveBeenCalled(),
            { timeout: 4000 },
          );
          if (kind === 'turn_failed') {
            expect(recorder.recordHealthFailure).toHaveBeenNthCalledWith(
              2,
              expect.objectContaining({ consecutiveFailures: 2 }),
            );
          }
        }
      } finally {
        await session.close();
        delay.mockRestore();
      }
    },
  );
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { klexConfigSchema } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import { SessionInboxUrgency } from '@/session/inbox';
import {
  createSessionHistory,
  SESSION_HISTORY_STORE_DEFINITION,
  type SessionHistory,
} from '@/session-history';
import { summarizeGenerationFailure } from '@/session-history/generation-health';

import { createChatSession } from './chat-session';
import type { TurnResult } from './turn';
import { BackoffManager } from './utils/backoff-manager';

const { createTurn } = vi.hoisted(() => ({ createTurn: vi.fn() }));
vi.mock('./turn', async (original) => ({
  ...(await original<typeof import('./turn')>()),
  createTurn,
}));

const success: TurnResult = {
  fatalError: false,
  fatalErrorReason: null,
  completeFailure: false,
  requestRejected: false,
  stopReason: 'completed',
  stepCount: 1,
  usage: null,
};
const failure = summarizeGenerationFailure(new Error('rate limit TPM: 30000'), {
  providerId: 'work',
  providerType: 'openai',
  modelId: 'gpt',
});
const logging = createLogger({ name: 'generation-health-test' });
let directory: string;
let history: SessionHistory;

afterEach(async () => {
  await history?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  createTurn.mockReset();
});

async function setup(result: TurnResult) {
  directory = await mkdtemp(join(tmpdir(), 'klex-generation-health-'));
  await createLocalData({
    logging,
    dataDirectory: directory,
    klexVersion: KLEX_VERSION,
    stores: [SESSION_HISTORY_STORE_DEFINITION],
  }).start();
  const config = { get: () => klexConfigSchema.parse({}) };
  history = createSessionHistory({ logging, dataDirectory: directory, config });
  await history.start();
  createTurn.mockImplementation(() => ({
    run: vi.fn(async () => result),
    abortGeneration: vi.fn(),
    abortTools: vi.fn(),
  }));
  // Keep the production failure counter and policy, but avoid real backoff delays.
  vi.spyOn(BackoffManager.prototype, 'getDelay').mockReturnValue(0);
  const removeChild = vi.fn();
  const scope = (): IntrospectionScope => ({
    path: [],
    introspect: vi.fn(),
    child: scope,
    removeChild,
  });
  const session = createChatSession({
    logging,
    config: config as never,
    modelResolver: { resolveModelInfo: () => undefined } as never,
    dataDirectory: directory,
    mcp: null,
    extensionFactories: [],
    introspectionScope: scope(),
    sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
    basePrompt: 'test',
    sessionHistory: history,
  });
  await session.start();
  session.inbox.send({
    sourceEnv: 'test',
    urgency: SessionInboxUrgency.Default,
    context: {
      sourceEnv: 'test',
      metadata: {},
      content: [{ type: 'text', text: 'private prompt' }],
    },
  });
  return { session, removeChild };
}

describe('ChatSession generation health persistence', () => {
  it.each(['budget', 'fatal'] as const)(
    'persists %s termination before removing live introspection',
    async (mode) => {
      const { session, removeChild } = await setup({
        ...success,
        completeFailure: true,
        fatalError: mode === 'fatal',
        fatalErrorReason: mode === 'fatal' ? 'invalid prompt' : null,
        stopReason: mode === 'fatal' ? 'fatal' : 'failure_budget_exhausted',
        generationFailure: failure,
      });
      await vi.waitFor(() =>
        expect(removeChild).toHaveBeenCalledWith('default'),
      );
      const page = await history.listSessions({ limit: 10 });
      expect(page.sessions).toHaveLength(1);
      expect(page.sessions[0]).toMatchObject({
        live: false,
        generationError: {
          kind: 'terminated',
          occurrenceCount: mode === 'fatal' ? 1 : 5,
          consecutiveFailures: mode === 'fatal' ? 1 : 5,
          providerType: 'openai',
        },
      });
      expect(createTurn).toHaveBeenCalledTimes(mode === 'fatal' ? 1 : 5);
      await session.close();
    },
  );

  it('keeps a rejected turn alive with one failure and clears it after a completed turn', async () => {
    const { session } = await setup({
      ...success,
      completeFailure: true,
      requestRejected: true,
      stopReason: 'failure_budget_exhausted',
      generationFailure: failure,
    });
    await expect(session.waitForIdle(1000)).resolves.toBe(true);
    expect(createTurn).toHaveBeenCalledTimes(1);
    const record = (await history.listSessions({ limit: 10 })).sessions[0];
    if (!record) throw new Error('Missing persisted session');
    expect(record).toMatchObject({
      live: true,
      generationError: { kind: 'request_rejected', consecutiveFailures: 1 },
    });
    createTurn.mockImplementation(() => ({
      run: vi.fn(async () => success),
      abortGeneration: vi.fn(),
      abortTools: vi.fn(),
    }));
    session.inbox.send({
      sourceEnv: 'test',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'test',
        metadata: {},
        content: [{ type: 'text', text: 'retry' }],
      },
    });
    await expect(session.waitForIdle(1000)).resolves.toBe(true);
    expect(
      (await history.getSession(record.instanceId))?.generationError,
    ).toBeNull();
    await session.close();
  });
});

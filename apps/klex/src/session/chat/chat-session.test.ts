import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import {
  sessionHistoryListResponseSchema,
  sessionHistoryRecordSchema,
} from '@/admin-api/routes/v1/schemas';
import {
  getSessionHistory,
  getSessionHistoryRoute,
  listSessionHistory,
  listSessionHistoryRoute,
} from '@/admin-api/routes/v1/sessions';
import { setupTestApp } from '@/admin-api/routes/v1/test-utils';
import { type Config, klexConfigSchema } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import { SessionInboxUrgency } from '@/session/inbox';
import {
  createSessionHistory,
  SESSION_HISTORY_STORE_DEFINITION,
} from '@/session-history';

import {
  type ChatSessionDependencies,
  createChatSession,
} from './chat-session';
import type { Turn, TurnDependencies } from './turn';
import { BackoffManager } from './utils/backoff-manager';

const { createTurnMock } = vi.hoisted(() => ({ createTurnMock: vi.fn() }));
vi.mock('./turn', async (original) => ({
  ...(await original<typeof import('./turn')>()),
  createTurn: createTurnMock,
}));

it('exposes a sanitized zero-message provider failure through HTTP and clears it after a real successful turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'klex-health-e2e-'));
  const logging = createLogger({ name: 'health-e2e' });
  const entry = { providerId: 'work', modelId: 'gpt' };
  const value = klexConfigSchema.parse({});
  value.modelSelection.chat = [entry];
  const config = {
    get: () => value,
    getRuntime: () => value,
    getModelSelection: () => [entry],
  } as unknown as Config;
  const history = createSessionHistory({
    logging,
    dataDirectory: directory,
    config,
  });
  const recovery = Promise.withResolvers<void>();
  const rejected = vi.fn(async () => {
    throw new APICallError({
      url: 'https://api.openai.com/v1/responses',
      requestBodyValues: {},
      statusCode: 429,
      message: 'OpenAI rate limit reached TPM: 30000 RPM: 500 sk-secret',
    });
  });
  const failing = new MockLanguageModelV4({ doStream: rejected });
  const working = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'text' });
          controller.enqueue({
            type: 'text-delta',
            id: 'text',
            delta: 'Recovered.',
          });
          controller.enqueue({ type: 'text-end', id: 'text' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  });
  let model = failing;
  const resolver: ChatSessionDependencies['modelResolver'] = {
    resolveInstinctCandidates: () => [],
    getLanguageModel: () => model,
    resolveModel: () => ({
      ...entry,
      providerType: 'openai',
      settings: {},
      contextSize: 32_000,
      capabilities: { input: {}, output: {} },
      inputCapabilities: {},
    }),
    resolveModelInfo: () => ({
      displayName: 'Test',
      contextSize: 32_000,
      capabilities: { input: {}, output: {} },
      inputCapabilities: {},
    }),
  };
  const scope = (): IntrospectionScope => ({
    path: [],
    introspect: vi.fn(),
    child: scope,
    removeChild: vi.fn(),
  });
  let turnCount = 0;
  createTurnMock.mockImplementation((deps: TurnDependencies): Turn => {
    const number = ++turnCount;
    let turn: Turn | undefined;
    return {
      run: async () => {
        const actual = await vi.importActual<typeof import('./turn')>('./turn');
        // Hold the automatic retry until the failed turn is observed over HTTP.
        if (number > 1) await recovery.promise;
        turn = actual.createTurn(deps);
        return turn.run();
      },
      abortGeneration: (reason) => turn?.abortGeneration(reason),
      abortTools: () => turn?.abortTools(),
    };
  });
  vi.spyOn(BackoffManager.prototype, 'getDelay').mockReturnValue(0);
  const session = createChatSession({
    logging,
    config,
    modelResolver: resolver,
    dataDirectory: directory,
    mcp: null,
    extensionFactories: [],
    introspectionScope: scope(),
    sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
    basePrompt: 'Test.',
    sessionHistory: history,
  });
  try {
    await createLocalData({
      logging,
      dataDirectory: directory,
      klexVersion: KLEX_VERSION,
      stores: [SESSION_HISTORY_STORE_DEFINITION],
    }).start();
    await history.start();
    // Restored context belongs to the predecessor. The new instance must be
    // visible on its first failed turn even though it has persisted no messages.
    const predecessor = history.openRecorder({
      instanceId: 'predecessor',
      sessionId: 'default',
      kind: 'default',
      name: 'main',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    predecessor.scheduleSync(() => [
      { id: 'input', role: 'user', parts: [{ type: 'text', text: 'Begin.' }] },
    ]);
    await predecessor.end('replaced');
    const app = setupTestApp((app) => {
      app.openapi(
        listSessionHistoryRoute,
        listSessionHistory({ sessionHistory: history }),
      );
      app.openapi(
        getSessionHistoryRoute,
        getSessionHistory({ sessionHistory: history }),
      );
    });
    await session.start();
    // Wake the restored session without appending another user message.
    (
      session as unknown as {
        onNewInput: (urgency: SessionInboxUrgency) => void;
      }
    ).onNewInput(SessionInboxUrgency.Default);
    await vi.waitFor(async () => {
      expect(
        (await history.listSessions({ limit: 10, live: true })).sessions[0]
          ?.generationError,
      ).toBeTruthy();
    });
    const response = await app.request('/v1/sessions');
    expect(response.status).toBe(200);
    const page = sessionHistoryListResponseSchema.parse(await response.json());
    expect(page.sessions).toHaveLength(2);
    const record = page.sessions.find((record) => record.live);
    if (!record) throw new Error('Missing failed session instance');
    expect(record).toMatchObject({
      messageCount: 0,
      generationError: {
        category: 'rate_limit',
        providerType: 'openai',
        providerId: 'work',
        modelId: 'gpt',
        statusCode: 429,
        consecutiveFailures: 1,
      },
    });
    expect(record.generationError?.message).toContain('TPM: 30000');
    expect(JSON.stringify(page)).not.toContain('sk-secret');
    expect(rejected).toHaveBeenCalled();
    expect(
      (await history.getMessages(record.instanceId, { limit: 10 }))?.messages,
    ).toEqual([]);
    const detail = await app.request(`/v1/sessions/${record.instanceId}`);
    expect(detail.status).toBe(200);
    expect(sessionHistoryRecordSchema.parse(await detail.json())).toEqual(
      record,
    );

    model = working;
    recovery.resolve();
    await expect(session.waitForIdle(5000)).resolves.toBe(true);
    const recovered = await app.request('/v1/sessions');
    expect(recovered.status).toBe(200);
    const recoveredPage = sessionHistoryListResponseSchema.parse(
      await recovered.json(),
    );
    const recoveredRecord = recoveredPage.sessions.find(
      (candidate) => candidate.instanceId === record.instanceId,
    );
    expect(recoveredRecord).toMatchObject({
      instanceId: record.instanceId,
      generationError: null,
    });
    expect(recoveredRecord?.messageCount).toBeGreaterThan(0);
    expect(working.doStreamCalls).toHaveLength(1);
    expect(createTurnMock).toHaveBeenCalledTimes(2);
    const recoveredDetail = await app.request(
      `/v1/sessions/${record.instanceId}`,
    );
    expect(recoveredDetail.status).toBe(200);
    expect(
      sessionHistoryRecordSchema.parse(await recoveredDetail.json()),
    ).toEqual(recoveredRecord);
  } finally {
    model = working;
    recovery.resolve();
    await session.close();
    await history.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    createTurnMock.mockReset();
  }
});

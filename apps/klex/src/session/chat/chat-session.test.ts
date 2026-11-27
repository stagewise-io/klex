import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type {
  HistoryTransformOptions,
  ResolvedModel,
} from './extensions/extension-api';
import { createDataPart } from './extensions/extension-api';
import { createSoulExt } from './extensions/soul';
import type { ExtendedUIMessage } from './message-types';
import type { Turn, TurnDependencies } from './turn';
import { BackoffManager } from './utils/backoff-manager';

const { createTurnMock } = vi.hoisted(() => ({ createTurnMock: vi.fn() }));
vi.mock('./turn', async (original) => ({
  ...(await original<typeof import('./turn')>()),
  createTurn: createTurnMock,
}));

it.each(['alone', 'before-soul', 'after-soul'] as const)(
  'drops history only without a soul, with a retaining skip extension %s',
  async (skipOrder) => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-soul-gate-'));
    const logging = createLogger({ name: 'soul-gate' });
    const value = klexConfigSchema.parse({});
    const scope = (): IntrospectionScope => ({
      path: [],
      introspect: vi.fn(),
      child: scope,
      removeChild: vi.fn(),
    });
    const generation = vi.fn();
    const session = createChatSession({
      logging,
      config: { get: () => value } as unknown as Config,
      modelResolver: {
        resolveModelInfo: () => undefined,
        getLanguageModel: generation,
      } as never,
      dataDirectory: directory,
      mcp: null,
      extensionFactories: (() => {
        const retainingSkip = {
          identifier: 'test/retaining-skip',
          create: () => ({ shouldRunStep: () => false }),
        };
        if (skipOrder === 'before-soul') return [retainingSkip, createSoulExt];
        if (skipOrder === 'after-soul') return [createSoulExt, retainingSkip];
        return [createSoulExt];
      })(),
      introspectionScope: scope(),
      sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
      basePrompt: 'Test.',
    });
    createTurnMock.mockReset();
    createTurnMock.mockImplementation(
      (deps: TurnDependencies): Turn => ({
        run: async () => {
          const actual =
            await vi.importActual<typeof import('./turn')>('./turn');
          return actual.createTurn(deps).run();
        },
        abortGeneration: vi.fn(),
        abortTools: vi.fn(),
      }),
    );
    try {
      await session.start();
      session.inbox.sendMessage(
        {
          id: 'pending-work',
          role: 'user',
          parts: [{ type: 'text', text: 'Work' }],
        },
        SessionInboxUrgency.Deferrable,
      );
      await expect(session.waitForIdle(3_000)).resolves.toBe(true);
      expect(session.getMessages()).toEqual([]);
      expect(generation).not.toHaveBeenCalled();
      const soulDir = join(directory, 'extensions', createSoulExt.identifier);
      await mkdir(soulDir, { recursive: true });
      await writeFile(join(soulDir, 'SOUL.md'), 'I help with precision.');
      await expect(session.waitForIdle(3_000)).resolves.toBe(true);
      expect(session.getMessages()).toEqual([]);
      session.inbox.sendMessage(
        {
          id: 'fresh-work',
          role: 'user',
          parts: [{ type: 'text', text: 'Fresh work' }],
        },
        SessionInboxUrgency.Default,
      );
      await expect(session.waitForIdle(3_000)).resolves.toBe(true);
      expect(session.getMessages().map((message) => message.id)).toEqual([
        'fresh-work',
      ]);
      await rm(join(soulDir, 'SOUL.md'));
      session.inbox.sendMessage(
        {
          id: 'blocked-again',
          role: 'user',
          parts: [{ type: 'text', text: 'More work' }],
        },
        SessionInboxUrgency.Default,
      );
      await expect(session.waitForIdle(3_000)).resolves.toBe(true);
      expect(session.getMessages().map((message) => message.id)).toEqual([
        'fresh-work',
      ]);
      expect(generation).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
      createTurnMock.mockReset();
    }
  },
);

it.each(['standard', 'without-extension'] as const)(
  'checks soul availability before realtime bootstrap in %s mode',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-soul-realtime-'));
    const value = klexConfigSchema.parse({});
    const scope = (): IntrospectionScope => ({
      path: [],
      introspect: vi.fn(),
      child: scope,
      removeChild: vi.fn(),
    });
    const onIdle = vi.fn();
    const assemblePrompt = vi.fn(() => 'Additional instructions.');
    const prepareMemory = vi.fn(
      async (): Promise<ExtendedUIMessage['parts']> => [
        createDataPart('loadedMemories', {
          'skills/test/bootstrap/SKILL.md': JSON.stringify({
            version: 1,
            kind: 'skill',
            title: 'Bootstrap',
            sections: [],
            body: 'Prepared lease memory',
          }),
        }) as unknown as ExtendedUIMessage['parts'][number],
      ],
    );
    const session = createChatSession({
      logging: createLogger({ name: 'soul-realtime' }),
      config: { get: () => value } as unknown as Config,
      modelResolver: {} as never,
      dataDirectory: directory,
      mcp: null,
      extensionFactories: [
        ...(mode === 'standard' ? [createSoulExt] : []),
        {
          identifier: 'test/context-assembly',
          create: () => ({
            getSystemPromptPart: assemblePrompt,
            onIdle,
            dataPartTransformers: { loadedMemories: () => [] },
            prepareHistoryAnnotations: prepareMemory,
          }),
        },
      ],
      introspectionScope: scope(),
      sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
      basePrompt: 'Test.',
    });
    const request = {
      mode: 'realtime' as const,
      externalSessionId: 'test-call',
      namespace: 'test',
      signal: new AbortController().signal,
      model: { modelId: 'test', contextSize: 32_000, inputCapabilities: {} },
    };
    try {
      await session.start();
      if (mode === 'standard') {
        const soulDir = join(directory, 'extensions', createSoulExt.identifier);
        await mkdir(soulDir, { recursive: true });
        for (const content of [null, '  ', '<soul></soul>']) {
          if (content !== null)
            await writeFile(join(soulDir, 'SOUL.md'), content);
          const lease = await session.acquireInteractionLease(request);
          try {
            await expect(lease.bootstrap()).rejects.toThrow(
              'Session extensions blocked interaction context preparation',
            );
            expect(assemblePrompt).not.toHaveBeenCalled();
            expect(prepareMemory).not.toHaveBeenCalled();
          } finally {
            await lease.release('setup-failed');
          }
        }
        await writeFile(join(soulDir, 'SOUL.md'), 'I help with precision.');
      }
      const lease = await session.acquireInteractionLease(request);
      try {
        const prepared = await lease.bootstrap();
        expect(prepared.context.instructions).toContain(
          'Additional instructions.',
        );
        if (mode === 'standard') {
          expect(prepared.context.instructions).toContain(
            'I help with precision.',
          );
        }
        expect(assemblePrompt).toHaveBeenCalledOnce();
        expect(prepareMemory).toHaveBeenCalledOnce();
        expect(JSON.stringify(prepared.context.messages)).toContain(
          'Prepared lease memory',
        );
        expect(
          session
            .getMessages()
            .at(-1)
            ?.parts.filter(
              (part) => (part.type as string) === 'data-loadedMemories',
            ),
        ).toHaveLength(1);
        prepared.rollback();
      } finally {
        await lease.release();
      }
      await expect(session.waitForIdle(3_000)).resolves.toBe(true);
      expect(onIdle).not.toHaveBeenCalled();
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([true, false])(
  'projects realtime bootstrap and live updates only when registered (%s)',
  async (enabled) => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-model-projection-'));
    const value = klexConfigSchema.parse({});
    const scope = (): IntrospectionScope => ({
      path: [],
      introspect: vi.fn(),
      child: scope,
      removeChild: vi.fn(),
    });
    const project = vi.fn(
      async (
        history: ExtendedUIMessage[],
        _model: ResolvedModel,
        _options?: HistoryTransformOptions,
      ) => {
        for (const message of history) {
          for (const part of message.parts) {
            if (part.type === 'data-context') {
              part.data.metadata.secret = 'projected';
              part.data.content = [
                {
                  type: 'text',
                  text: `projected ${'x'.repeat(1_000)} tail-preserved`,
                },
              ];
            }
          }
        }
        return history;
      },
    );
    const session = createChatSession({
      logging: createLogger({ name: 'model-projection' }),
      config: { get: () => value } as unknown as Config,
      modelResolver: {} as never,
      dataDirectory: directory,
      mcp: null,
      extensionFactories: enabled
        ? [
            {
              identifier: 'test/projection',
              create: () => ({ historyTransformer: project }),
            },
          ]
        : [],
      introspectionScope: scope(),
      sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
      basePrompt: 'Test.',
    });
    try {
      await session.start();
      const lease = await session.acquireInteractionLease({
        mode: 'realtime',
        externalSessionId: 'test-call',
        namespace: 'test',
        signal: new AbortController().signal,
        model: { modelId: 'test', contextSize: 32_000, inputCapabilities: {} },
      });
      try {
        const send = (id: string) =>
          session.inbox.send({
            sourceEnv: 'fixture',
            urgency: SessionInboxUrgency.Default,
            context: {
              sourceEnv: 'fixture',
              metadata: { secret: id },
              content: [{ type: 'text', text: id }],
            },
          });
        send('bootstrap-secret');
        const prepared = await lease.bootstrap();
        const text = JSON.stringify(prepared.context.messages);
        expect(text).toContain(enabled ? 'projected' : 'bootstrap-secret');
        if (enabled) expect(text).not.toContain('bootstrap-secret');
        prepared.commit();
        send('live-secret');
        const update = (await lease.updates[Symbol.asyncIterator]().next())
          .value!;
        const delivered = await lease.prepareUpdate!(update);
        expect(delivered.event.context.metadata.secret).toBe('live-secret');
        expect(delivered.sequence).toBe(update.sequence);
        expect(delivered.eventId).toBe(update.eventId);
        if (enabled) {
          expect(delivered.modelText).toContain('projected');
          expect(delivered.modelText).toContain('tail-preserved');
          expect(delivered.modelText).not.toContain('live-secret');
          expect(
            project.mock.calls.map(([, , options]) => options?.purpose),
          ).toEqual(['inference', 'realtime-update']);
        } else {
          expect(delivered.modelText).toBeUndefined();
          expect(project).not.toHaveBeenCalled();
        }
        expect(JSON.stringify(session.getMessages())).toContain('live-secret');
        expect(JSON.stringify(session.getMessages())).not.toContain(
          'projected',
        );
        lease.acknowledgeUpdate(update.sequence);
      } finally {
        await lease.release();
      }
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
  const onIdle = vi.fn();
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
    extensionFactories: [
      { identifier: 'test/idle-observer', create: () => ({ onIdle }) },
    ],
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

    expect(onIdle).not.toHaveBeenCalled();
    model = working;
    recovery.resolve();
    await expect(session.waitForIdle(5000)).resolves.toBe(true);
    expect(onIdle).toHaveBeenCalledOnce();
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

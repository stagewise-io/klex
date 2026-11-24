import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import z from 'zod';

import { createLogger } from '@stagewise/logger';

import { type Config, interpolateEnvironment } from '@/config';
import { completeV2Config } from '@/config/config.test-fixtures';
import { createIntrospector } from '@/introspection';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import { SessionInboxUrgency } from '@/session/inbox';
import { DEFAULT_SESSION_ID, type SessionFactory } from '@/session/types';
import {
  createSessionHistory,
  SESSION_HISTORY_STORE_DEFINITION,
} from '@/session-history';
import { createTelemetrySpanProcessor } from '@/telemetry-manager';
import { createTelemetryPolicy } from '@/telemetry-policy';
import {
  type ConversationEpochOptions,
  createTracing,
  type Tracing,
} from '@/tracing';

import {
  type ChatSessionDependencies,
  createChatSession,
} from './chat-session';
import type { ExtensionFactory } from './extensions/extension-api';

const logging = createLogger({
  name: 'session-conversation-epoch-test',
  type: 'hidden',
});

const usage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function streamParts(parts: LanguageModelV4StreamPart[]) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

function userMessage(text: string) {
  return {
    id: crypto.randomUUID(),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  };
}

function makeConfig(): Config {
  const raw = {
    ...completeV2Config,
    officialName: 'Knuth',
    providers: { test: { type: 'openai', settings: { apiKey: 'test-key' } } },
    modelSelection: {
      ...completeV2Config.modelSelection,
      chat: [{ providerId: 'test', modelId: 'chat-model' }],
    },
  };
  return {
    get: () => raw,
    getRuntime: () => interpolateEnvironment(raw, {}),
    getModelSelection: ((purpose) =>
      interpolateEnvironment(raw, {}).modelSelection[
        purpose
      ]) as Config['getModelSelection'],
    subscribe: () => () => {},
  } as unknown as Config;
}

function makeModelResolver(
  streamFn: () => ReturnType<typeof streamParts>,
  generateTextReply = 'summary',
): ChatSessionDependencies['modelResolver'] {
  const model = new MockLanguageModelV4({
    provider: 'openai.chat',
    modelId: 'chat-model',
    doStream: async () => streamFn(),
    doGenerate: async () => ({
      content: [{ type: 'text', text: generateTextReply }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
  });
  return {
    getLanguageModel: () => model,
    resolveModel: (entry) => ({
      ...entry,
      providerType: 'openai',
      settings: {},
      contextSize: 32_000,
      capabilities: { input: {}, output: {} },
      inputCapabilities: {},
    }),
    resolveModelInfo: () => ({
      displayName: 'Test Model',
      contextSize: 32_000,
      capabilities: { input: {}, output: {} },
      inputCapabilities: {},
    }),
    resolveInstinctCandidates: () => [],
  };
}

function recordedChatSpans(spans: readonly ReadableSpan[]): ReadableSpan[] {
  return spans.filter(
    (span) =>
      span.attributes['gen_ai.operation.name'] === 'chat' &&
      span.attributes['agento11y.record'] === true,
  );
}

function toolSpans(spans: readonly ReadableSpan[]): ReadableSpan[] {
  return spans.filter(
    (span) => span.attributes['gen_ai.operation.name'] === 'execute_tool',
  );
}

describe('ChatSession bounded gen_ai.conversation.id', () => {
  const exporter = new InMemorySpanExporter();
  const processor = createTelemetrySpanProcessor('advanced');
  const policy = createTelemetryPolicy('advanced');
  let tracing: Tracing;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    processor.setDelegate(new SimpleSpanProcessor(exporter));
    tracing = createTracing({
      logging,
      serviceName: 'klex',
      spanProcessor: processor,
      policy,
      agentName: 'Knuth',
      getAgentId: () => 'agent-123',
      fallbackAgentId: 'instance-fallback',
      enabled: true,
    });
    await tracing.start();
  });

  afterEach(() => {
    exporter.reset();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await tracing.close();
    trace.disable();
    context.disable();
  });

  it('aligns chat and execute_tool spans on the active epoch, excludes wrapper spans, and rotates on checkpoint, count cap, and idle gap', async () => {
    let now = 1_000_000;
    let suffixSeq = 0;
    let callIndex = 0;
    let commitCheckpoint!: (anchorId: string) => void;
    let runHousekeeping!: (extId: string) => Promise<void>;

    const streamFn = () => {
      callIndex += 1;
      // First call invokes a tool so we verify execute_tool aligns with chat.
      if (callIndex === 1) {
        return streamParts([
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'ping',
            input: '{}',
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
          },
        ]);
      }
      return streamParts([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: `reply-${callIndex}` },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
        },
      ]);
    };

    const testToolsExt: ExtensionFactory = {
      identifier: 'test/tools',
      create: (deps) => {
        commitCheckpoint = (anchorId) => {
          deps.checkpoints.commit({
            coversThroughMessageId: anchorId,
            summary: 'compacted summary',
          });
        };
        return {
          getTools: () => ({
            ping: tool({
              description: 'ping tool',
              inputSchema: z.object({}),
              execute: async () => ({ ok: true }),
            }),
          }),
        };
      },
    };

    const makeHousekeepingExt = (identifier: string): ExtensionFactory => ({
      identifier,
      create: (deps) => ({
        onStart: async () => {
          const prev = runHousekeeping;
          runHousekeeping = async (targetId: string) => {
            if (targetId === identifier) {
              await deps.generateText({
                modelIds: [{ providerId: 'test', modelId: 'chat-model' }],
                prompt: `housekeeping ${identifier}`,
              });
              return;
            }
            await prev?.(targetId);
          };
        },
      }),
    });

    const epochOptions: ConversationEpochOptions = {
      initialEpochId: 'boot001',
      maxGenerations: 2,
      idleGapMs: 60_000,
      now: () => now,
      createSuffix: () => `r${++suffixSeq}`,
    };

    const session = createChatSession({
      logging,
      config: makeConfig(),
      modelResolver: makeModelResolver(streamFn),
      dataDirectory: '/tmp',
      mcp: null,
      extensionFactories: [
        testToolsExt,
        makeHousekeepingExt('io.stagewise/context-compaction'),
        makeHousekeepingExt('io.stagewise/episode-summary'),
      ],
      introspectionScope: createIntrospector({ logging }).child('sessions'),
      sessionContext: {
        kind: 'default',
        name: 'main',
        sessionId: DEFAULT_SESSION_ID,
      },
      basePrompt: 'You are Knuth.',
      conversationEpochOptions: epochOptions,
    });

    const sendAndWait = async (text: string) => {
      session.inbox.sendMessage(userMessage(text), SessionInboxUrgency.Default);
      expect(await session.waitForIdle(5_000)).toBe(true);
    };

    try {
      await session.start();

      // Turn 1: 2 generations (step 1 calls `ping`, step 2 answers) -> both fit in boot001.
      await sendAndWait('hello 1');
      await tracing.forceFlush();

      let spans = exporter.getFinishedSpans();
      let chats = recordedChatSpans(spans);
      const tools = toolSpans(spans);
      expect(chats).toHaveLength(2);
      expect(tools).toHaveLength(1);
      expect(chats.map((s) => s.attributes['gen_ai.conversation.id'])).toEqual([
        'default:agent-123:boot001',
        'default:agent-123:boot001',
      ]);
      expect(chats[0]?.attributes['gen_ai.agent.name']).toBe('Knuth');
      expect(chats[0]?.attributes['gen_ai.agent.id']).toBe('agent-123');
      // execute_tool carries the exact matching bounded conversation id & agent name.
      expect(tools[0]?.attributes['agento11y.record']).toBe(true);
      expect(tools[0]?.attributes['gen_ai.conversation.id']).toBe(
        'default:agent-123:boot001',
      );
      expect(tools[0]?.attributes['gen_ai.agent.name']).toBe('Knuth');
      // Wrapper invoke_agent and step spans are excluded from Agent O11y.
      for (const wrapper of spans.filter(
        (s) =>
          s.attributes['gen_ai.operation.name'] === 'invoke_agent' ||
          s.attributes['gen_ai.operation.name'] === 'agent_step',
      )) {
        expect(wrapper.attributes['agento11y.record']).toBe(false);
        expect(wrapper.attributes['gen_ai.conversation.id']).toBeUndefined();
      }

      // Background housekeeping calls stay out of Agent O11y AND do not consume
      // generation budget or reset idle timers.
      exporter.reset();
      await runHousekeeping('io.stagewise/context-compaction');
      await runHousekeeping('io.stagewise/episode-summary');
      await tracing.forceFlush();

      spans = exporter.getFinishedSpans();
      expect(recordedChatSpans(spans)).toHaveLength(0);
      const housekeepingChats = spans.filter(
        (s) => s.attributes['gen_ai.operation.name'] === 'chat',
      );
      expect(housekeepingChats).toHaveLength(2);
      for (const span of housekeepingChats) {
        expect(span.attributes['agento11y.record']).toBe(false);
        expect(span.attributes['gen_ai.conversation.id']).toBeUndefined();
      }

      // Generation 3 exceeds maxGenerations=2 -> rolls over to boot001:r1.
      exporter.reset();
      now += 1_000;
      await sendAndWait('hello 2');
      await tracing.forceFlush();
      chats = recordedChatSpans(exporter.getFinishedSpans());
      expect(chats).toHaveLength(1);
      expect(chats[0]?.attributes['gen_ai.conversation.id']).toBe(
        'default:agent-123:boot001:r1',
      );

      // Advance past idleGapMs (60_000) -> rolls over to boot001:r2.
      exporter.reset();
      now += 60_000;
      await sendAndWait('hello after idle');
      await tracing.forceFlush();
      chats = recordedChatSpans(exporter.getFinishedSpans());
      expect(chats).toHaveLength(1);
      expect(chats[0]?.attributes['gen_ai.conversation.id']).toBe(
        'default:agent-123:boot001:r2',
      );

      // Apply a compaction checkpoint -> rotates to default:agent-123:{checkpointId}.
      exporter.reset();
      const messages = session.getMessages();
      const anchor = messages[messages.length - 2];
      if (!anchor) throw new Error('expected anchor message');
      commitCheckpoint(anchor.id);
      await sendAndWait('hello after checkpoint');
      await tracing.forceFlush();

      const checkpointHeader = session.getMessages()[0];
      if (!checkpointHeader) throw new Error('expected checkpoint header');
      chats = recordedChatSpans(exporter.getFinishedSpans());
      expect(chats).toHaveLength(1);
      expect(chats[0]?.attributes['gen_ai.conversation.id']).toBe(
        `default:agent-123:${checkpointHeader.id}`,
      );
    } finally {
      await session.close();
    }
  });

  it('opens a fresh checkpoint-scoped epoch on restart so unpersisted helper calls cannot reopen a full conversation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'klex-epoch-restart-'));
    tempDirs.push(dir);
    let now = Date.parse('2026-11-24T10:00:00.000Z');
    const localData = createLocalData({
      logging,
      dataDirectory: dir,
      klexVersion: KLEX_VERSION,
      stores: [SESSION_HISTORY_STORE_DEFINITION],
    });
    await localData.start();
    const sessionHistory = createSessionHistory({
      logging,
      dataDirectory: dir,
      config: makeConfig(),
      now: () => new Date(now),
    });
    await sessionHistory.start();

    const makeStream = () =>
      streamParts([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'ok' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
        },
      ]);

    let commitCheckpoint!: (anchorId: string) => void;
    let runHelper!: () => Promise<void>;
    const checkpointAndHelperExt: ExtensionFactory = {
      identifier: 'test/vision',
      create: (deps) => {
        commitCheckpoint = (anchorId) => {
          deps.checkpoints.commit({
            coversThroughMessageId: anchorId,
            summary: 'persisted summary',
          });
        };
        runHelper = async () => {
          await deps.generateText({
            modelIds: [{ providerId: 'test', modelId: 'chat-model' }],
            prompt: 'describe image',
          });
        };
        return {};
      },
    };

    const openSession = (
      epochOptions: ConversationEpochOptions,
      extensions: ExtensionFactory[] = [],
    ) =>
      createChatSession({
        logging,
        config: makeConfig(),
        modelResolver: makeModelResolver(makeStream),
        dataDirectory: dir,
        mcp: null,
        extensionFactories: extensions,
        introspectionScope: createIntrospector({ logging }).child('sessions'),
        sessionContext: {
          kind: 'default',
          name: 'main',
          sessionId: DEFAULT_SESSION_ID,
        },
        basePrompt: 'You are Knuth.',
        sessionHistory,
        conversationEpochOptions: epochOptions,
      });

    let checkpointId: string;
    try {
      // Boot 1: commit checkpoint, then fill maxGenerations=2 via 1 chat reply
      // + 1 recorded helper call (only 1 assistant message is persisted in SQLite).
      const boot1 = openSession(
        {
          initialEpochId: 'boot-1',
          maxGenerations: 2,
          idleGapMs: 60_000,
          now: () => now,
        },
        [checkpointAndHelperExt],
      );
      await boot1.start();
      boot1.inbox.sendMessage(
        userMessage('msg 1'),
        SessionInboxUrgency.Default,
      );
      expect(await boot1.waitForIdle(5_000)).toBe(true);
      boot1.inbox.sendMessage(
        userMessage('msg 2'),
        SessionInboxUrgency.Default,
      );
      expect(await boot1.waitForIdle(5_000)).toBe(true);
      const anchor = boot1.getMessages()[1];
      if (!anchor) throw new Error('expected anchor message');
      commitCheckpoint(anchor.id);

      exporter.reset();
      boot1.inbox.sendMessage(
        userMessage('msg 3'),
        SessionInboxUrgency.Default,
      );
      expect(await boot1.waitForIdle(5_000)).toBe(true);
      await runHelper();
      const header = boot1.getMessages()[0];
      if (!header) throw new Error('expected checkpoint header');
      checkpointId = header.id;
      await boot1.close();
      await sessionHistory.flush();
      await tracing.forceFlush();

      let chats = recordedChatSpans(exporter.getFinishedSpans());
      expect(chats.map((s) => s.attributes['gen_ai.conversation.id'])).toEqual([
        `default:agent-123:${checkpointId}`,
        `default:agent-123:${checkpointId}`,
      ]);

      // Boot 2: quick restart 5 seconds later must NOT reopen the full
      // `default:agent-123:{checkpointId}` bucket; it opens a fresh suffix.
      exporter.reset();
      now += 5_000;
      const boot2 = openSession({
        initialEpochId: 'boot-2',
        maxGenerations: 2,
        idleGapMs: 60_000,
        now: () => now,
        createSuffix: () => 'boot2',
      });
      await boot2.start();
      boot2.inbox.sendMessage(
        userMessage('msg 4'),
        SessionInboxUrgency.Default,
      );
      expect(await boot2.waitForIdle(5_000)).toBe(true);
      await boot2.close();
      await sessionHistory.flush();
      await tracing.forceFlush();

      chats = recordedChatSpans(exporter.getFinishedSpans());
      expect(chats).toHaveLength(1);
      expect(chats[0]?.attributes['gen_ai.conversation.id']).toBe(
        `default:agent-123:${checkpointId}:boot2`,
      );

      // Boot 3: subsequent restart opens another distinct suffix.
      exporter.reset();
      now += 120_000;
      const boot3 = openSession({
        initialEpochId: 'boot-3',
        maxGenerations: 2,
        idleGapMs: 60_000,
        now: () => now,
        createSuffix: () => 'boot3',
      });
      await boot3.start();
      boot3.inbox.sendMessage(
        userMessage('msg 5'),
        SessionInboxUrgency.Default,
      );
      expect(await boot3.waitForIdle(5_000)).toBe(true);
      await boot3.close();
      await tracing.forceFlush();

      chats = recordedChatSpans(exporter.getFinishedSpans());
      expect(chats).toHaveLength(1);
      expect(chats[0]?.attributes['gen_ai.conversation.id']).toBe(
        `default:agent-123:${checkpointId}:boot3`,
      );
    } finally {
      await sessionHistory.close();
      await localData.close();
    }
  });

  it('bounds long-lived memory-retrieval child sessions with epoch rollover', async () => {
    let now = 5_000;
    let suffixSeq = 0;
    const makeStream = () =>
      streamParts([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'recalled' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
        },
      ]);

    const config = makeConfig();
    const modelResolver = makeModelResolver(makeStream);
    const childEpochOptions: ConversationEpochOptions = {
      initialEpochId: 'mem01',
      maxGenerations: 2,
      idleGapMs: 60_000,
      now: () => now,
      createSuffix: () => `mr${++suffixSeq}`,
    };

    const childFactory: SessionFactory = (params) =>
      createChatSession({
        logging,
        config,
        modelResolver,
        dataDirectory: '/tmp',
        mcp: params.mcp,
        extensionFactories: params.extensionFactories,
        introspectionScope: params.introspectionScope,
        hooks: params.hooks,
        sessionContext: params.sessionContext,
        basePrompt: params.basePrompt,
        parentSpanContext: params.parentSpanContext,
        conversationEpochOptions: childEpochOptions,
      });

    const parent = createChatSession({
      logging,
      config,
      modelResolver,
      dataDirectory: '/tmp',
      mcp: null,
      extensionFactories: [],
      introspectionScope: createIntrospector({ logging }).child('sessions'),
      sessionContext: {
        kind: 'default',
        name: 'main',
        sessionId: DEFAULT_SESSION_ID,
      },
      sessionFactory: childFactory,
      basePrompt: 'Parent',
    });

    try {
      await parent.start();
      const retrieval = await parent.createChildSession({
        name: 'memory-retrieval',
        extensionIdentifier: 'memory',
        extensions: [],
        basePrompt: 'Retrieve memory.',
        boundedConversation: true,
      });

      const sendToChild = async (text: string) => {
        retrieval.inbox.sendMessage(
          userMessage(text),
          SessionInboxUrgency.Default,
        );
        expect(await retrieval.waitForIdle(5_000)).toBe(true);
      };

      await sendToChild('obs 1');
      await sendToChild('obs 2');
      // 3rd call hits maxGenerations=2 -> rolls over.
      await sendToChild('obs 3');
      // Idle gap -> rolls over again.
      now += 60_000;
      await sendToChild('obs 4');

      await tracing.forceFlush();
      const ids = recordedChatSpans(exporter.getFinishedSpans()).map(
        (span) => span.attributes['gen_ai.conversation.id'],
      );
      expect(ids).toEqual([
        `${retrieval.sessionId}:mem01`,
        `${retrieval.sessionId}:mem01`,
        `${retrieval.sessionId}:mem01:mr1`,
        `${retrieval.sessionId}:mem01:mr2`,
      ]);
      await retrieval.close();
    } finally {
      await parent.close();
    }
  });
});

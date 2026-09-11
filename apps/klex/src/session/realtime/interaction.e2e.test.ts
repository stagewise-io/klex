import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jsonSchema } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';
import type { PushNotificationNotification } from '@stagewise/mcp-extension-push-notifications';

import type { Config, ConfigListener, McpServerConfig } from '@/config';
import { createIntrospector } from '@/introspection';
import {
  type ConnectMcpServerOptions,
  createMcp,
  type McpConnection,
} from '@/mcp';
import { createRouter } from '@/router';
import type { ChatSessionDependencies } from '@/session/chat/chat-session';
import type { ExtensionFactory } from '@/session/chat/extensions/extension-api';
import type { ChatSessionHandle } from '@/session/types';

import { createRealtimeSessionCoordinator } from './session-coordinator';
import {
  createDeterministicEchoProcessorFactory,
  createDeterministicMediaTransportConnector,
  DETERMINISTIC_REALTIME_MODEL,
} from './test-support';

vi.mock('@/session/chat/utils/system-prompt.md', () => ({
  default: 'You are Klex.',
}));

const errorLog = vi.fn();
const warnLog = vi.fn();
const logging = {
  child: () => ({
    debug: () => undefined,
    error: errorLog,
    info: () => undefined,
    trace: () => undefined,
    warn: warnLog,
  }),
} as unknown as RootLogger;

function createConfig(servers: Record<string, McpServerConfig>): Config {
  let listener: ConfigListener | undefined;
  return {
    get: () => ({ modelSelection: { chat: ['remote:test:model'] } }),
    getMcpServers: () => servers,
    subscribe: (next: ConfigListener) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
  } as unknown as Config;
}

function seededMcpToolExtension(): ExtensionFactory {
  return {
    identifier: 'io.stagewise/test-e2e',
    create: (deps) => ({
      historyTransformer: (history) => [
        {
          id: 'seed-framing',
          role: 'assistant',
          parts: [{ type: 'text', text: 'I will join the voice call now.' }],
        },
        {
          id: 'seed-tool-result',
          role: 'user',
          parts: [{ type: 'text', text: 'Tool result: joined voice call.' }],
        },
        ...history,
      ],
      getTools: () => ({
        echo: {
          description: 'Echo through the connected MCP server',
          inputSchema: jsonSchema<{ value: string }>({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          }),
          execute: (input, options) =>
            deps.mcp.invoke({ namespace: 'voice', name: 'echo' }, input, {
              executionId: options.toolCallId,
              sessionId: deps.sessionId,
              signal: options.abortSignal ?? new AbortController().signal,
            }),
        },
      }),
    }),
  };
}

describe('realtime and primary chat interaction', () => {
  it('runs the lean happy path through MCP, router, chat, and realtime', async () => {
    const { createChatSession } = await import('@/session/chat/chat-session');
    let connectOptions: ConnectMcpServerOptions | undefined;
    let chatSession: ChatSessionHandle | undefined;
    const subscriptionClosed = Promise.withResolvers<void>();
    const invoke = vi.fn(async (_tool, input) => ({
      content: [{ type: 'text' as const, text: `echo:${String(input.value)}` }],
      structuredContent: { echoed: input.value },
    }));
    const connection = {
      namespace: 'voice',
      tools: [
        {
          name: 'echo',
          description: 'Echo a value',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
      supportsPushNotifications: true,
      pushNotifications: {
        listen: vi.fn(async () => ({ closed: subscriptionClosed.promise })),
        getEvents: vi.fn(async () => ({ events: [], hasMore: false })),
        acknowledgeEvents: vi.fn(async () => undefined),
      },
      supportsRealtimeMedia: true,
      realtimeMedia: {
        listen: vi.fn(async () => ({ closed: subscriptionClosed.promise })),
        accept: vi.fn(async () => ({
          transport: {
            kind: 'livekit-room' as const,
            descriptor: {
              profile: 'livekit-room' as const,
              url: 'wss://livekit.example.test',
              token: 'secret',
            },
          },
        })),
        reject: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
      },
      invoke,
      close: vi.fn(async () => subscriptionClosed.resolve()),
    } as unknown as McpConnection;
    const config = createConfig({
      voice: { url: 'https://voice.example/mcp' },
    });
    const mcp = createMcp({
      logging,
      config,
      realtimeMediaCapability: {
        transports: ['livekit-room'],
        media: ['audio'],
      },
      dataDirectory: join(tmpdir(), 'klex-interaction-e2e'),
      connect: async (options) => {
        connectOptions = options;
        return connection;
      },
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('Unexpected chat generation');
      },
    });
    const modelResolver: ChatSessionDependencies['modelResolver'] = {
      getLanguageModel: () => model,
      resolveModel: () => ({
        providerId: 'test',
        providerType: 'test',
        modelId: 'model',
        settings: {},
        contextSize: 32_000,
        capabilities: { input: {}, output: {} },
        inputCapabilities: {},
      }),
      resolveModelInfo: () => ({
        contextSize: 32_000,
        displayName: 'Test Model',
        capabilities: { input: {}, output: {} },
        inputCapabilities: {},
      }),
    };
    const introspection = createIntrospector({ logging });
    const router = createRouter({
      logging,
      mcp,
      introspection,
      createChatSession: (
        hooks,
        introspectionScope,
        sessionRouter,
        sessionId,
      ) => {
        chatSession = createChatSession({
          logging,
          config,
          modelResolver,
          mcp,
          router: sessionRouter,
          extensionFactories: [seededMcpToolExtension()],
          dataDirectory: join(tmpdir(), 'klex-interaction-e2e'),
          introspectionScope,
          hooks,
          sessionId,
        });
        return chatSession;
      },
    });
    const connector = createDeterministicMediaTransportConnector();
    const processorFactory = createDeterministicEchoProcessorFactory();
    const coordinator = createRealtimeSessionCoordinator({
      logging,
      mcp,
      mediaTransportConnector: connector,
      processorFactory,
      conversationHost: router,
      model: DETERMINISTIC_REALTIME_MODEL,
      now: () => Date.parse('2026-08-01T18:00:00.000Z'),
    });

    await router.start();
    await coordinator.start();
    await mcp.start();
    await vi.waitFor(() => expect(connectOptions).toBeDefined());
    await vi.waitFor(() =>
      expect(connection.realtimeMedia?.listen).toHaveBeenCalledOnce(),
    );
    await connectOptions?.onRealtimeMediaNotification(connection, {
      jsonrpc: '2.0',
      method: 'io.stagewise/realtime-media/session-offered',
      params: {
        sessionId: 'call-1',
        expiresAt: '2026-08-01T19:00:00.000Z',
      },
    });

    await connector.nextTransport();
    const processor = await processorFactory.nextProcessor();
    expect(processor.context.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: [
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('join the voice call'),
            }),
          ],
        }),
        expect.objectContaining({
          role: 'user',
          content: [
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('Tool result: joined voice call'),
            }),
          ],
        }),
      ]),
    );
    expect(processor.context.tools).toEqual([
      expect.objectContaining({ name: 'echo' }),
    ]);

    const push = {
      method: 'io.stagewise/push-notifications/event',
      params: {
        event: {
          eventId: 'notification-1',
          sourceId: 'chat:user',
          type: 'chat.message.received',
          createdAt: '2026-08-01T18:01:00.000Z',
          content: [{ type: 'text' as const, text: 'A live notification' }],
        },
      },
    } as PushNotificationNotification;
    await connectOptions?.onPushNotification(connection, push);
    await vi.waitFor(() => expect(processor.receivedUpdates).toHaveLength(1));
    expect(processor.receivedUpdates[0]).toMatchObject({
      eventId: 'voice:notification-1',
      requestResponse: true,
    });

    await processor.emit({
      type: 'tool-call',
      eventId: 'tool-call-1',
      request: {
        executionId: 'execution-1',
        name: 'echo',
        input: { value: 'hello' },
      },
    });
    await vi.waitFor(() =>
      expect(processor.receivedToolResults).toHaveLength(1),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(processor.receivedToolResults[0]).toMatchObject({
      executionId: 'execution-1',
      status: 'success',
    });

    await processor.emit({
      type: 'user-transcript',
      eventId: 'user-transcript-1',
      text: 'Can you hear me?',
    });
    await processor.emit({
      type: 'assistant-transcript',
      eventId: 'assistant-transcript-1',
      text: 'Loud and clear.',
    });
    await vi.waitFor(() =>
      expect(
        chatSession
          ?.getMessages()
          .some((message) => message.id === 'assistant-transcript-1'),
      ).toBe(true),
    );

    await connectOptions?.onRealtimeMediaNotification(connection, {
      jsonrpc: '2.0',
      method: 'io.stagewise/realtime-media/session-ended',
      params: { sessionId: 'call-1', reason: 'remote-end' },
    });
    await vi.waitFor(() => expect(coordinator.getActiveSessionCount()).toBe(0));
    expect(chatSession?.getSessionInfo().runtimeState).toBe('idle');

    const releaseProbe = await router.acquireInteractionLease({
      mode: 'realtime',
      externalSessionId: 'release-probe',
      namespace: 'voice',
      signal: new AbortController().signal,
      model: DETERMINISTIC_REALTIME_MODEL,
    });
    await releaseProbe.release('call-ended');
    await expect(releaseProbe.closed).resolves.toEqual({
      type: 'released',
      reason: 'call-ended',
    });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();

    const messages = chatSession?.getMessages() ?? [];
    expect(messages.some((message) => message.id === 'user-transcript-1')).toBe(
      true,
    );
    expect(
      messages.some((message) => message.id === 'assistant-transcript-1'),
    ).toBe(true);
    expect(
      messages.some((message) =>
        message.parts.some(
          (part) =>
            part.type === 'data-context' &&
            part.data.content.some(
              (content) =>
                content.type === 'text' &&
                content.text === 'A live notification',
            ),
        ),
      ),
    ).toBe(true);

    await coordinator.close();
    await mcp.close();
    await router.close();
  });
});

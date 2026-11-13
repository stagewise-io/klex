import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import {
  type Config,
  klexConfigSchema,
  type ModelSelectionEntry,
} from '@/config';
import type { IntrospectionScope } from '@/introspection';
import { SessionInboxUrgency } from '@/session/inbox';

import {
  type ChatSessionDependencies,
  createChatSession,
} from './chat-session';

it.each([
  'healthy',
  'empty',
  'resolution',
  'runtime',
  'rejected',
  'chat-backup',
] as const)(
  'uses chat fallback when memory models are unavailable: %s',
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-memory-fallback-'));
    const value = klexConfigSchema.parse({});
    const memory = { providerId: 'test', modelId: 'memory' };
    const chat = { providerId: 'test', modelId: 'chat' };
    const backup = { providerId: 'test', modelId: 'backup' };
    value.modelSelection.memory = failure === 'empty' ? [] : [memory];
    value.modelSelection.chat =
      failure === 'chat-backup' ? [chat, backup] : [chat];
    const attempted: string[] = [];
    const working = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text' });
            controller.enqueue({
              type: 'text-delta',
              id: 'text',
              delta: 'Memory processed.',
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
    const failing = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          url: 'https://example.test/generate',
          requestBodyValues: {},
          statusCode: failure === 'rejected' ? 404 : 503,
          isRetryable: false,
          message: 'Model unavailable',
        });
      },
    });
    const info = {
      displayName: 'Test',
      contextSize: 32_000,
      capabilities: { input: {}, output: {} },
      inputCapabilities: {},
    };
    const resolver: ChatSessionDependencies['modelResolver'] = {
      resolveInstinctCandidates: () => [],
      getLanguageModel: (entry: ModelSelectionEntry) => {
        attempted.push(entry.modelId);
        if (entry.modelId === 'memory' && failure === 'resolution')
          throw new Error('Provider unavailable');
        return (entry.modelId === 'memory' && failure !== 'healthy') ||
          (entry.modelId === 'chat' && failure === 'chat-backup')
          ? failing
          : working;
      },
      resolveModel: (entry) => ({
        ...entry,
        ...info,
        providerType: 'openai',
        settings: {},
      }),
      resolveModelInfo: () => info,
    };
    const scope = (): IntrospectionScope => ({
      path: [],
      introspect: vi.fn(),
      child: scope,
      removeChild: vi.fn(),
    });
    const session = createChatSession({
      logging: createLogger({ name: 'memory-fallback-test' }),
      config: {
        get: () => value,
        getModelSelection: (purpose) => value.modelSelection[purpose],
      } as Config,
      modelResolver: resolver,
      dataDirectory: directory,
      mcp: null,
      extensionFactories: [],
      introspectionScope: scope(),
      sessionContext: {
        kind: 'child',
        name: 'memory-writer',
        sessionId: 'writer-test',
      },
      basePrompt: 'Process memory.',
      modelPurpose: 'memory',
      fallbackModelPurposes: ['chat'],
    });
    try {
      await session.start();
      session.inbox.sendMessage(
        {
          id: 'input',
          role: 'user',
          parts: [{ type: 'text', text: 'Process this evidence.' }],
        },
        SessionInboxUrgency.Default,
      );
      await vi.waitFor(
        () =>
          expect(JSON.stringify(session.getMessages())).toContain(
            'Memory processed.',
          ),
        { timeout: 10_000 },
      );
      expect(attempted[0]).toBe(failure === 'empty' ? 'chat' : 'memory');
      expect(attempted.at(-1)).toBe(
        failure === 'healthy'
          ? 'memory'
          : failure === 'chat-backup'
            ? 'backup'
            : 'chat',
      );
      expect(session.getSessionInfo().status).not.toBe('terminated');
      if (failure === 'healthy') {
        expect(attempted).toEqual(['memory']);
        await session.waitForIdle(3_000);
        value.modelSelection.memory = [];
        session.inbox.sendMessage(
          {
            id: 'next',
            role: 'user',
            parts: [{ type: 'text', text: 'Next batch.' }],
          },
          SessionInboxUrgency.Default,
        );
        await vi.waitFor(() => expect(attempted.at(-1)).toBe('chat'));
      }
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

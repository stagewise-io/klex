import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import { createIntrospector } from '@/introspection';
import {
  type ChatSessionDependencies,
  createChatSession,
} from '@/session/chat';
import { createEpisodeFeed } from '@/session/chat/extensions/memory';
import type { ChatSessionHandle, SessionFactory } from '@/session/types';

import { createLearningExt } from './learning';
import { createSkillCatalog } from './skill-store';

vi.mock('./extraction-prompt.md', () => ({
  default: 'Extract. {{NAME}} {{SOUL}}',
}));
vi.mock('./consolidation-prompt.md', () => ({ default: 'Consolidate.' }));
vi.mock('./system-prompt-part.md', () => ({ default: '## Learned skills\n' }));
vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: '',
}));
vi.mock('@/session/chat/extensions/memory/memory', () => ({
  createMemoryExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/memory/retrieval', () => ({
  EPISODIC_SEARCH_INDEX_STORE_DEFINITION: {},
}));

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
};
const logging = { child: () => logger } as unknown as RootLogger;

function stream(parts: LanguageModelV4StreamPart[]) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
function toolStream(toolName: string, input: unknown, id: string) {
  return stream([
    {
      type: 'tool-call',
      toolCallId: id,
      toolName,
      input: JSON.stringify(input),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
      usage,
    },
  ]);
}

describe('learning child session execution', () => {
  it('investigates and persists through streamed steps, then idles and releases parent quiescence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klex-learning-session-'));
    const id = '2026-10-01/1-09-00.jsonl';
    const episodicDir = join(root, 'episodic');
    await mkdir(join(episodicDir, '2026-10-01'), { recursive: true });
    await copyFile(
      new URL('./fixtures/feedback.jsonl', import.meta.url),
      join(episodicDir, id),
    );
    const episodes = createEpisodeFeed();
    const read = vi.spyOn(episodes, 'readPage');
    const catalog = createSkillCatalog();
    const introspection = createIntrospector({ logging });
    const finish = Promise.withResolvers<void>();
    const finalStep = Promise.withResolvers<void>();
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const current = step++;
        if (current === 0)
          return toolStream(
            'readEpisode',
            { id, offset: 0, limit: 1000 },
            'read',
          );
        if (current === 1)
          return toolStream(
            'submitLearnings',
            {
              operations: [
                {
                  op: 'create',
                  name: 'ask-first',
                  description: 'Use before core contract changes.',
                  body: 'Ask for approval before changing core contracts.',
                  evidenceEpisodes: [id],
                },
              ],
            },
            'submit',
          );
        if (current !== 2) throw new Error('Unexpected learning step');
        finalStep.resolve();
        await finish.promise;
        return stream([
          { type: 'text-start', id: 'done' },
          { type: 'text-delta', id: 'done', delta: 'Done.' },
          { type: 'text-end', id: 'done' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage,
          },
        ]);
      },
    });
    const config = {
      get: () => ({
        officialName: 'Atlas',
        modelSelection: { chat: ['test:model'], memory: ['test:model'] },
      }),
      getModelSelection: () => [{ providerId: 'test', modelId: 'model' }],
    } as unknown as Config;
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
        displayName: 'Test',
        capabilities: { input: {}, output: {} },
        inputCapabilities: {},
      }),
    };
    const children: ChatSessionHandle[] = [];
    const sessionFactory = vi.fn<SessionFactory>((params) => {
      const child = createChatSession({
        logging,
        config,
        modelResolver,
        dataDirectory: root,
        ...params,
        sessionFactory,
      });
      children.push(child);
      return child;
    });
    const parent = createChatSession({
      logging,
      config,
      modelResolver,
      dataDirectory: root,
      mcp: null,
      extensionFactories: [
        createLearningExt({
          episodes,
          skillCatalog: catalog,
          getSoul: () => 'Product manager.',
        }),
      ],
      introspectionScope: introspection,
      sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
      sessionFactory,
      basePrompt: 'Main session.',
    });
    try {
      await parent.start();
      expect(parent.isQuiescent()).toBe(true);
      episodes.attach({ episodicDir, getOpenEpisode: async () => null });
      await vi.waitFor(() => expect(step).toBe(3));
      await finalStep.promise;
      expect(parent.isQuiescent()).toBe(false);
      expect(children).toHaveLength(1);
      const child = children[0];
      if (!child) throw new Error('Learning child missing');
      expect(child.getSessionInfo().status).toBe('active');
      const params = sessionFactory.mock.calls[0]?.[0];
      if (!params) throw new Error('Child factory was not called');
      expect(params.modelPurpose).toBe('memory');
      expect(params.mcp).toBeNull();
      expect(params.basePrompt).toContain('Extract. Atlas Product manager.');
      expect(
        params.extensionFactories.map((factory) => factory.identifier),
      ).toEqual(['io.stagewise/learning-investigation']);
      expect(
        await introspection.read([
          'default',
          'child-sessions',
          child.sessionId,
        ]),
      ).toBeDefined();
      expect(catalog.get('ask-first')?.body).toContain('Ask for approval');
      expect(catalog.getUsage('ask-first')?.sourceEpisodes).toEqual([id]);
      expect(read).toHaveBeenCalledTimes(2);
      expect(model.doStreamCalls).toHaveLength(3);
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
        'readEpisode',
      );
      finish.resolve();
      await vi.waitFor(() =>
        expect(child.getSessionInfo().status).toBe('terminated'),
      );
      await vi.waitFor(() => expect(parent.isQuiescent()).toBe(true));
      expect(catalog.get('ask-first')).not.toBeNull();
      expect(
        await introspection.read([
          'default',
          'child-sessions',
          child.sessionId,
        ]),
      ).toBeUndefined();
    } finally {
      finish.resolve();
      await parent.close();
      expect(parent.isQuiescent()).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});

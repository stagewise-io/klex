import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';

import { createLogger, type RootLogger } from '@stagewise/logger';

import { type Config, klexConfigSchema } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import type { ChatSessionHandle } from '@/session/types';
import {
  createSessionHistory,
  SESSION_HISTORY_STORE_DEFINITION,
  type SessionHistory,
} from '@/session-history';

import { createChatSession } from './chat-session';
import { isCheckpointHeader } from './checkpoint';
import type {
  ExtensionDeps,
  ExtensionFactory,
} from './extensions/extension-api';
import { createMemoryExt } from './extensions/memory';
import { outputTexts } from './extensions/memory/episodes/test-utils';
import type { ExtendedUIMessage } from './message-types';

vi.mock('./extensions/memory/system-prompt-part.md', () => ({
  default: 'Memory.',
}));
vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: 'Time.',
}));
vi.mock('./extensions/memory/retrieval', () => ({
  createMemoryRetrievalCoordinator: () => ({
    start: async () => {},
    close: async () => {},
    setMainTurnActive: () => {},
    observe: () => true,
    introspect: () => ({}),
  }),
  recallInputSchema: z.object({}),
  RecallRejectedError: class extends Error {},
  renderObservation: () => ({ text: '', cursor: null, hasMore: false }),
}));

const STATE_PART = 'data-test-state';
const TURNS = 40;
const CHECKPOINT_EVERY = 5;
/** Header + the uncovered last turn + up to CHECKPOINT_EVERY turns. */
const WINDOW_BOUND = 1 + 2 + 2 * CHECKPOINT_EVERY;

const quiet = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};
const logging = { child: () => quiet } as unknown as RootLogger;
const directories: string[] = [];
const histories: SessionHistory[] = [];

afterEach(async () => {
  await Promise.all(histories.splice(0).map((history) => history.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function scope(path: string[] = []): IntrospectionScope {
  return {
    path,
    introspect: vi.fn(),
    child: vi.fn((id: string) => scope([...path, id])),
    removeChild: vi.fn(),
  };
}

async function openHistory(dataDirectory: string): Promise<SessionHistory> {
  const logger = createLogger({ name: 'test' });
  await createLocalData({
    logging: logger,
    dataDirectory,
    klexVersion: KLEX_VERSION,
    stores: [SESSION_HISTORY_STORE_DEFINITION],
  }).start();
  const config = klexConfigSchema.parse({});
  const history = createSessionHistory({
    logging: logger,
    dataDirectory,
    config: { get: () => config },
  });
  histories.push(history);
  await history.start();
  return history;
}

/** Exposes the producer's deps so the test can commit checkpoints. */
function producer(): { factory: ExtensionFactory; deps: () => ExtensionDeps } {
  let captured: ExtensionDeps | undefined;
  return {
    factory: {
      identifier: 'test/producer',
      create: (deps) => {
        captured = deps;
        return {};
      },
    },
    deps: () => {
      if (!captured) throw new Error('producer deps not captured');
      return captured;
    },
  };
}

/** Carries the latest `STATE_PART` value seen in the dropped prefix. */
const carry: ExtensionFactory = {
  identifier: 'test/carry',
  create: () => ({
    getCheckpointCarry: (dropped) => {
      const parts = dropped
        .flatMap((message) => message.parts)
        .filter((part: { type: string }) => part.type === STATE_PART);
      const last = parts.at(-1);
      return last ? [last] : [];
    },
  }),
};

function createSession(
  dataDirectory: string,
  history: SessionHistory,
  extensions: ExtensionFactory[],
): ChatSessionHandle {
  const parsed = klexConfigSchema.parse({});
  const config = {
    get: () => ({
      ...parsed,
      modelSelection: { ...parsed.modelSelection, chat: ['test:model'] },
    }),
  } as unknown as Config;
  return createChatSession({
    logging,
    config,
    modelResolver: { resolveModelInfo: () => undefined } as never,
    dataDirectory,
    mcp: null,
    extensionFactories: [createMemoryExt(), carry, ...extensions],
    introspectionScope: scope(),
    sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
    basePrompt: 'You are Klex.',
    sessionHistory: history,
  });
}

interface Internals {
  instanceId: string;
  messages: ExtendedUIMessage[];
  idleCheckpointApply: Promise<void> | null;
  flushPendingImmediate: () => void;
}

function internals(session: ChatSessionHandle): Internals {
  return session as unknown as Internals;
}

function turn(index: number): ExtendedUIMessage[] {
  return [
    {
      id: `u${index}`,
      role: 'user',
      parts: [
        { type: 'text', text: `question ${index}` },
        { type: STATE_PART, data: { turn: index } },
      ],
    } as unknown as ExtendedUIMessage,
    {
      id: `a${index}`,
      role: 'assistant',
      parts: [{ type: 'text', text: `answer ${index}` }],
    },
  ];
}

async function recordedEpisodes(dataDirectory: string): Promise<string[]> {
  const texts: string[] = [];
  const entries = await readdir(dataDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() && entry.parentPath.split(/[\\/]/).includes('episodic'),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    texts.push(...outputTexts(await readFile(file, 'utf-8')));
  }
  return texts;
}

function stateParts(message: ExtendedUIMessage | undefined) {
  return (message?.parts ?? []).filter(
    (part: { type: string }) => part.type === STATE_PART,
  );
}

describe('default session bounded window (end to end)', () => {
  it('keeps the window bounded, logs everything, and restores the same window', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'klex-bounded-e2e-'));
    directories.push(dataDirectory);
    const history = await openHistory(dataDirectory);
    const checkpointProducer = producer();
    const first = createSession(dataDirectory, history, [
      checkpointProducer.factory,
    ]);
    await first.start();
    const state = internals(first);
    let maxLength = 0;
    let checkpoints = 0;

    for (let index = 0; index < TURNS; index++) {
      state.messages.push(...turn(index));
      state.flushPendingImmediate();
      maxLength = Math.max(maxLength, state.messages.length);
      if ((index + 1) % CHECKPOINT_EVERY !== 0) continue;

      // Cover everything but the last turn, like compaction does.
      const anchor = state.messages.at(-3)?.id;
      if (!anchor) throw new Error('missing anchor');
      const result = checkpointProducer.deps().checkpoints.commit({
        coversThroughMessageId: anchor,
        summary: `summary through turn ${index - 1}`,
      });
      expect(result).toEqual({ status: 'pending' });
      await state.idleCheckpointApply;
      checkpoints++;

      const header = state.messages[0];
      expect(isCheckpointHeader(header)).toBe(true);
      // Exactly one carried state part: the latest one from the dropped prefix.
      expect(stateParts(header)).toEqual([
        { type: STATE_PART, data: { turn: index - 1 } },
      ]);
      expect(state.messages.slice(1).map((m) => m.id)).toEqual([
        `u${index}`,
        `a${index}`,
      ]);
    }

    expect(checkpoints).toBe(TURNS / CHECKPOINT_EVERY);
    expect(maxLength).toBeLessThanOrEqual(WINDOW_BOUND);
    expect(state.messages.length).toBe(3);

    const finalWindow = structuredClone(state.messages);
    const firstInstanceId = state.instanceId;
    await first.close();
    await history.flush();

    // The append-only log keeps every message plus every header, in order.
    const page = await history.getMessages(firstInstanceId, { limit: 1_000 });
    const loggedIds = page?.messages.map((entry) => entry.message.id) ?? [];
    const turnIds = Array.from({ length: TURNS }, (_, i) => [
      `u${i}`,
      `a${i}`,
    ]).flat();
    expect(loggedIds.filter((id) => turnIds.includes(id))).toEqual(turnIds);
    expect(loggedIds).toHaveLength(turnIds.length + checkpoints);

    // Every answer was recorded once, before or at its trim.
    const answers = Array.from({ length: TURNS }, (_, i) => `answer ${i}`);
    expect(await recordedEpisodes(dataDirectory)).toEqual(answers);

    // A new instance on the same store restores the identical window.
    const second = createSession(dataDirectory, history, []);
    await second.start();
    expect(internals(second).messages).toEqual(finalWindow);

    // The restored window is neither re-logged nor re-recorded.
    internals(second).messages.push(...turn(TURNS));
    internals(second).flushPendingImmediate();
    await second.close();
    await history.flush();
    const secondPage = await history.getMessages(internals(second).instanceId, {
      limit: 1_000,
    });
    expect(secondPage?.messages.map((entry) => entry.message.id)).toEqual([
      `u${TURNS}`,
      `a${TURNS}`,
    ]);
    expect(await recordedEpisodes(dataDirectory)).toEqual([
      ...answers,
      `answer ${TURNS}`,
    ]);
  });
});

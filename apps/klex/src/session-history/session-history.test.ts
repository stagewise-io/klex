import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { type KlexConfig, klexConfigSchema } from '@/config';
import { createInputProjections } from '@/input-projections';
import type { SqliteStoreDefinition } from '@/local-data';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { summarizeGenerationFailure } from './generation-health';
import {
  CHECKPOINT_PART_TYPE,
  SESSION_HISTORY_INIT_SQL,
  SESSION_HISTORY_RELATIVE_PATH,
  SESSION_HISTORY_STORE_DEFINITION,
} from './schema';
import {
  createSessionHistory,
  DEFAULT_SESSION_HISTORY_MAX_BYTES,
  InvalidSessionHistoryCursorError,
  resolveSessionHistoryMaxBytes,
  type SessionHistory,
} from './session-history';
import type { SessionHistoryRecorderMetadata } from './types';

const logger = createLogger({ name: 'test' });
const directories: string[] = [];
const modules: SessionHistory[] = [];

function message(id: string, text = id, role = 'user'): ExtendedUIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
  } as unknown as ExtendedUIMessage;
}

function meta(
  overrides: Partial<SessionHistoryRecorderMetadata> = {},
): SessionHistoryRecorderMetadata {
  return {
    instanceId: randomUUID(),
    sessionId: 'default',
    kind: 'default',
    name: 'Default',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup(
  options: { maxBytes?: number; directory?: string; now?: () => Date } = {},
) {
  const directory =
    options.directory ??
    (await mkdtemp(join(tmpdir(), 'klex-session-history-')));
  if (!options.directory) directories.push(directory);
  await createLocalData({
    logging: logger,
    dataDirectory: directory,
    klexVersion: KLEX_VERSION,
    stores: [SESSION_HISTORY_STORE_DEFINITION],
  }).start();
  let config: KlexConfig = klexConfigSchema.parse({});
  if (options.maxBytes !== undefined) {
    config = { ...config, sessionHistory: { maxBytes: options.maxBytes } };
  }
  const history = createSessionHistory({
    logging: logger,
    dataDirectory: directory,
    config: { get: () => config },
    now: options.now,
  });
  modules.push(history);
  await history.start();
  return {
    directory,
    history,
    setMaxBytes(maxBytes: number) {
      config = { ...config, sessionHistory: { maxBytes } };
    },
  };
}

async function storedIds(history: SessionHistory, instanceId: string) {
  const page = await history.getMessages(instanceId, { limit: 200 });
  return page?.messages.map((entry) => entry.message.id);
}

afterEach(async () => {
  await Promise.all(modules.splice(0).map((module) => module.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('input projection storage', () => {
  // Recovery and review fairness regression contracts.
  it('audit: realtime fallback stays pinned while a later helper can learn for future events', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages: ExtendedUIMessage[] = [
      {
        id: 'realtime-first',
        role: 'user',
        parts: [
          {
            type: 'data-context',
            data: {
              sourceEnv: 'audit',
              metadata: {
                origin: 'events',
                type: 'message',
                data: {
                  message: 'hello',
                  traceId: 'x'.repeat(8_000),
                },
              },
              content: [],
            },
          },
        ],
      },
    ];
    recorder.scheduleSync(() => messages);
    const projections = createInputProjections(history);
    await projections.prepare('default', messages);
    const part = messages[0]!.parts[0];
    if (part?.type !== 'data-context') throw new Error('Missing context');
    const before = projections.present('default', part.data);
    expect(before.metadata.projectionStatus).toBe('fallback');
    const generate = vi.fn().mockResolvedValue({ success: false });
    await projections.prepare('default', messages, {
      generate,
      modelIds: [{ providerId: 'audit', modelId: 'chat' }],
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(projections.present('default', part.data)).toEqual(before);
    await projections.close();
  });

  it('caps helper calls across a flood of new shapes', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages: ExtendedUIMessage[] = Array.from(
      { length: 12 },
      (_, i) => ({
        id: `shape-${i}`,
        role: 'user',
        parts: [
          {
            type: 'data-context',
            data: {
              sourceEnv: 'flood',
              metadata: {
                origin: 'events',
                data: { message: 'hello', [`trace${i}`]: 'x'.repeat(8_000) },
              },
              content: [],
            },
          },
        ],
      }),
    );
    recorder.scheduleSync(() => messages);
    const projections = createInputProjections(history);
    const generate = vi.fn().mockResolvedValue({ success: false });
    await projections.prepare('default', messages, {
      generate,
      modelIds: [{ providerId: 'test', modelId: 'chat' }],
    });
    expect(generate).toHaveBeenCalledTimes(2);
    for (const message of messages) {
      const part = message.parts[0];
      if (part?.type !== 'data-context') throw new Error('Missing context');
      const ref = projections.present('default', part.data).metadata
        .inputEventRef as string;
      expect(await history.readInputProjection('default', ref)).toBeDefined();
    }
    await projections.close();
  });

  it('audit: reordering an unchanged source message preserves its durable reference', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const source: ExtendedUIMessage = {
      id: 'source',
      role: 'user',
      parts: [
        {
          type: 'data-context',
          data: {
            sourceEnv: 'audit',
            metadata: {
              origin: 'events',
              data: {
                message: 'hello',
                traceId: 'x'.repeat(8_000),
              },
            },
            content: [],
          },
        },
      ],
    };
    const later = message('later');
    let messages = [source, later];
    recorder.scheduleSync(() => messages);
    const projections = createInputProjections(history);
    await projections.prepare('default', messages);
    const part = source.parts[0];
    if (part?.type !== 'data-context') throw new Error('Missing context');
    const reference = projections.present('default', part.data).metadata
      .inputEventRef as string;
    expect(
      await history.readInputProjection('default', reference),
    ).toBeDefined();
    messages = [later, source];
    recorder.scheduleSync(() => messages);
    await projections.prepare('default', messages);
    expect(
      await history.readInputProjection('default', reference),
    ).toBeDefined();
    expect(
      projections.present('default', part.data).metadata.inputEventRef,
    ).toBe(reference);
    await projections.close();
  });

  it('audit: a failed review backs off without blocking other sections', async () => {
    const { history } = await setup();
    await history.saveInputProjectionPlan({
      revision: 'review-audit',
      family: 'audit',
      shape: 'shape',
      body: JSON.stringify({
        version: 1,
        fields: [{ path: ['message'], type: 'string', section: 'other' }],
      }),
    });
    for (const section of ['other', 'raw'])
      for (let i = 0; i < 10; i++)
        await history.recordInputProjectionFetch(
          'review-audit',
          section,
          `Need ${section} ${i}`,
        );
    const generate = vi.fn().mockResolvedValue({ success: false });
    const projections = createInputProjections(history);
    const generation = {
      generate,
      modelIds: [{ providerId: 'audit', modelId: 'chat' }],
    };
    await projections.prepare('default', [], generation);
    await projections.prepare('default', [], generation);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(
      generate.mock.calls.map(
        (call) => JSON.parse(call[0].prompt).review.section,
      ),
    ).toEqual(['other', 'raw']);
    expect(await history.pendingInputProjectionReviews()).toEqual([]);
    await projections.close();
  });
  it('persists ten-fetch batches, reviews at a safe boundary, and pins old events', async () => {
    const first = await setup();
    const recorder = first.history.openRecorder(meta());
    const make = (id: string): ExtendedUIMessage => ({
      id,
      role: 'user',
      parts: [
        {
          type: 'data-context',
          data: {
            sourceEnv: 'feedback',
            metadata: {
              origin: 'events',
              type: 'message',
              eventId: id,
              data: { message: id, traceId: 'x'.repeat(8_000) },
            },
            content: [],
          },
        },
      ],
    });
    const messages = [make('before')];
    const generate = vi.fn().mockImplementation(async (args) => {
      const parsed = JSON.parse(args.prompt);
      const fields = Array.isArray(parsed) ? parsed : parsed.fields;
      return {
        success: true,
        finishReason: 'stop',
        output: {
          assignments: fields.map(
            (field: { fieldId: string; path: string[] }) => ({
              fieldId: field.fieldId,
              section:
                !Array.isArray(parsed) || field.path[0] === 'message'
                  ? 'default'
                  : 'objectIds',
            }),
          ),
        },
      };
    });
    const generation = {
      generate,
      modelIds: [{ providerId: 'test', modelId: 'chat' }],
    };
    const projections = createInputProjections(first.history);
    recorder.scheduleSync(() => messages);
    await projections.prepare('default', messages, generation);
    const context = messages[0]!.parts[0];
    if (context?.type !== 'data-context') throw new Error('Missing context');
    const before = projections.present('default', context.data);
    const ref = before.metadata.inputEventRef as string;
    for (let i = 0; i < 9; i++)
      await projections.readSection(
        'default',
        ref,
        'objectIds',
        undefined,
        `Need trace ${i}`,
      );
    expect(await first.history.pendingInputProjectionReviews()).toEqual([]);
    const page = (await projections.readSection(
      'default',
      ref,
      'objectIds',
    )) as { nextCursor: string };
    await projections.readSection(
      'default',
      ref,
      'objectIds',
      page.nextCursor,
      'Continuation must not count',
    );
    await projections.readSection(
      'wrong',
      ref,
      'objectIds',
      undefined,
      'Denied must not count',
    );
    await projections.readSection(
      'default',
      ref,
      'links',
      undefined,
      'Unknown must not count',
    );
    await projections.close();
    await first.history.close();
    let now = Date.now();
    const second = await setup({
      directory: first.directory,
      now: () => new Date(now),
    });
    const restored = createInputProjections(second.history);
    await restored.readSection(
      'default',
      ref,
      'objectIds',
      undefined,
      'Need trace 9',
    );
    const pending = await second.history.pendingInputProjectionReviews();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.reasons).toEqual(
      Array.from({ length: 10 }, (_, i) => `Need trace ${i}`),
    );
    const failed = {
      ...generation,
      generate: vi.fn().mockResolvedValue({ success: false }),
    };
    await restored.prepare('default', messages, failed);
    expect(await second.history.pendingInputProjectionReviews()).toEqual([]);
    await restored.prepare('default', messages, generation);
    expect(generate).toHaveBeenCalledTimes(1);
    now += 60_001;
    expect(await second.history.pendingInputProjectionReviews()).toHaveLength(
      1,
    );
    await restored.prepare('default', messages, generation);
    expect(await second.history.pendingInputProjectionReviews()).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(2);
    const reviewPrompt = JSON.parse(generate.mock.calls[1]![0].prompt);
    expect(reviewPrompt.review.reasons).toEqual(pending[0]?.reasons);
    expect(restored.present('default', context.data)).toEqual(before);
    const nextRecorder = second.history.openRecorder(meta());
    messages.push(make('after'));
    nextRecorder.scheduleSync(() => messages);
    await restored.prepare('default', messages, generation);
    const next = messages[1]!.parts[0];
    if (next?.type !== 'data-context') throw new Error('Missing context');
    expect(restored.present('default', next.data).metadata.data).toHaveProperty(
      'traceId',
    );
    // Requests pinned to the old revision still produce the next disjoint ten-reason batch.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        restored.readSection(
          'default',
          ref,
          'objectIds',
          undefined,
          `Again ${i}`,
        ),
      ),
    );
    const batch2 = await second.history.pendingInputProjectionReviews();
    expect(batch2[0]?.batch).toBe(2);
    expect(batch2[0]?.reasons).toHaveLength(10);
    // The first review already superseded this revision: do not spend a helper
    // call or let feedback from pinned old events overwrite the learned plan.
    await restored.prepare('default', messages, generation);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await second.history.pendingInputProjectionReviews()).toEqual([]);
    expect(restored.present('default', context.data)).toEqual(before);
    await restored.close();
  });

  it('reuses known shapes, isolates variants and preserves pinned details', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const make = (
      id: string,
      extra: Record<string, string> = {},
    ): ExtendedUIMessage => ({
      id,
      role: 'user',
      parts: [
        {
          type: 'data-context',
          data: {
            sourceEnv: 'fixture',
            metadata: {
              origin: 'events',
              type: 'message',
              eventId: id,
              data: {
                message: `Fact ${id}`,
                traceId: 'x'.repeat(8_000),
                ...extra,
              },
            },
            content: [],
          },
        },
      ],
    });
    const messages = [make('first')];
    const generate = vi.fn().mockImplementation(async (args) => ({
      success: true,
      finishReason: 'stop',
      output: {
        assignments: JSON.parse(args.prompt).map(
          (field: { fieldId: string; path: string[] }) => ({
            fieldId: field.fieldId,
            section: field.path.at(-1) === 'traceId' ? 'objectIds' : 'default',
          }),
        ),
      },
    }));
    const generation = {
      generate,
      modelIds: [{ providerId: 'fixture', modelId: 'chat' }],
    };
    const projections = createInputProjections(history);
    const prepare = async () => {
      recorder.scheduleSync(() => messages);
      await projections.prepare('default', messages, generation);
    };
    await prepare();
    const first = messages[0]!.parts[0];
    if (first?.type !== 'data-context')
      throw new Error('Missing fixture context');
    const pinned = projections.present('default', first.data);
    expect(pinned.metadata.data).toEqual({ message: 'Fact first' });
    expect(Buffer.byteLength(JSON.stringify(pinned.metadata))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(first.data.metadata)) / 2,
    );
    messages.push(make('second'));
    await prepare();
    expect(generate).toHaveBeenCalledTimes(1);
    messages.push(make('changed', { newFact: 'Must stay visible' }));
    await prepare();
    expect(generate).toHaveBeenCalledTimes(2);
    const changed = messages[2]!.parts[0];
    if (changed?.type !== 'data-context')
      throw new Error('Missing fixture context');
    expect(projections.present('default', changed.data).metadata.data).toEqual({
      message: 'Fact changed',
      newFact: 'Must stay visible',
    });
    expect(projections.present('default', first.data)).toEqual(pinned);
    const details = (await projections.readSection(
      'default',
      pinned.metadata.inputEventRef as string,
      'objectIds',
    )) as { chunk: string; nextCursor: string | null };
    expect(details.chunk).toContain('traceId');
    expect(first.data.metadata.data).toHaveProperty(
      'traceId',
      'x'.repeat(8_000),
    );
  });

  it('detects reference collisions without binding another source and expires evicted sources', async () => {
    const { history } = await setup();
    const context = {
      sourceEnv: 'fixture',
      metadata: { origin: 'events', data: { message: 'fact' } },
      content: [],
    };
    const sources: ExtendedUIMessage[] = ['one', 'two'].map((id) => ({
      id,
      role: 'user',
      parts: [{ type: 'data-context', data: context }],
    }));
    history.openRecorder(meta()).scheduleSync(() => sources);
    await history.flush();
    const binding = {
      reference: 'abcdefgh',
      sessionId: 'default',
      messageId: 'one',
      part: 0,
      contextHash: createHash('sha256')
        .update(JSON.stringify(context))
        .digest('hex'),
      revision: 'identity-v1',
    };
    expect(await history.bindInputProjection(binding)).toEqual(binding);
    expect(
      await history.bindInputProjection({ ...binding, messageId: 'two' }),
    ).toBeUndefined();
    expect(
      await history.bindInputProjection({
        ...binding,
        messageId: 'two',
        reference: 'ijklmnop',
      }),
    ).toMatchObject({ reference: 'ijklmnop', messageId: 'two' });
    expect(
      (await history.readInputProjection('default', 'abcdefgh'))?.binding
        .messageId,
    ).toBe('one');
  });
  it('does not cache small-event identity decisions for later large events of the same shape', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const context = (traceId: string) => ({
      sourceEnv: 'fixture',
      metadata: {
        origin: 'events',
        type: 'message',
        data: { message: 'keep', traceId },
      },
      content: [],
    });
    const small = context('short');
    const large = context('x'.repeat(8_000));
    const source = (id: string, data: typeof small): ExtendedUIMessage => ({
      id,
      role: 'user',
      parts: [{ type: 'data-context', data }],
    });
    const messages = [source('small', small)];
    recorder.scheduleSync(() => messages);
    const projections = createInputProjections(history);
    const generate = vi.fn().mockResolvedValue({
      success: true,
      finishReason: 'stop',
      output: {
        assignments: [
          { fieldId: 'f0', section: 'default' },
          { fieldId: 'f1', section: 'objectIds' },
        ],
      },
    });
    const generation = {
      generate,
      modelIds: [{ providerId: 'fixture', modelId: 'chat' }],
    };
    await projections.prepare('default', messages, generation);
    expect(generate).not.toHaveBeenCalled();
    expect(projections.present('default', small).metadata.data).toEqual(
      small.metadata.data,
    );
    messages.push(source('large', large));
    recorder.scheduleSync(() => messages);
    await projections.prepare('default', messages, generation);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(projections.present('default', large).metadata.data).toEqual({
      message: 'keep',
    });
    expect(projections.present('default', small).metadata.data).toEqual(
      small.metadata.data,
    );
  });
  it('assigns references to content-only notifications and rejects unadvertised sections', async () => {
    const { history } = await setup();
    const context = {
      sourceEnv: 'fixture',
      metadata: { origin: 'push-notifications' },
      content: [{ type: 'text' as const, text: 'hello' }],
    };
    const source: ExtendedUIMessage = {
      id: 'content-only',
      role: 'user',
      parts: [{ type: 'data-context', data: context }],
    };
    history.openRecorder(meta()).scheduleSync(() => [source]);
    const projections = createInputProjections(history);
    await projections.prepare('default', [source]);
    const presented = projections.present('default', context);
    expect(presented.content).toEqual(context.content);
    expect(presented.metadata.inputEventRef).toMatch(/^[a-z0-9]{8}$/);
    expect(
      await projections.readSection(
        'default',
        presented.metadata.inputEventRef as string,
        'links',
      ),
    ).toEqual({ status: 'unknown-section' });
  });
  it('prepares compact defaults and recovers all raw details across service restart', async () => {
    const { history } = await setup();
    const context = {
      sourceEnv: 'fixture',
      metadata: {
        origin: 'events',
        type: 'message',
        data: {
          message: 'Keep this fact',
          debug: { traceId: 'x'.repeat(8_000) },
        },
      },
      content: [],
    };
    const source = {
      id: 'compact-source',
      role: 'user',
      parts: [{ type: 'data-context', data: context }],
    } as ExtendedUIMessage;
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [source]);
    const projections = createInputProjections(history);
    await projections.prepare('default', [source]);
    const compact = projections.present('default', context);
    expect(compact.metadata.data).toEqual({ message: 'Keep this fact' });
    expect(context.metadata.data.debug.traceId).toHaveLength(8_000);
    const reference = compact.metadata.inputEventRef as string;
    const restarted = createInputProjections(history);
    await restarted.prepare('default', [source]);
    expect(restarted.present('default', context).metadata.inputEventRef).toBe(
      reference,
    );
    let cursor: string | undefined;
    let text = '';
    do {
      const result = (await restarted.readSection(
        'default',
        reference,
        'raw',
        cursor,
      )) as { chunk: string; nextCursor: string | null };
      text += result.chunk;
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(JSON.parse(text)).toEqual(context.metadata);
    expect(await restarted.readSection('child', reference, 'raw')).toEqual({
      status: 'unavailable',
    });
  });
  it('binds only durable matching sources, pins plans, scopes reads and survives restart', async () => {
    const { history, directory } = await setup();
    const context = {
      sourceEnv: 'fixture',
      metadata: { origin: 'events', data: { nested: { id: 'original' } } },
      content: [],
    };
    const source = {
      id: 'event-source',
      role: 'user',
      parts: [{ type: 'data-context', data: context }],
    } as ExtendedUIMessage;
    const binding = {
      reference: 'abcdefgh',
      sessionId: 'default',
      messageId: source.id,
      part: 0,
      contextHash: createHash('sha256')
        .update(JSON.stringify(context))
        .digest('hex'),
      revision: 'revision-1',
    };
    expect(await history.bindInputProjection(binding)).toBeUndefined();
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [source]);
    await history.flush();
    const plan = {
      revision: 'revision-1',
      family: 'fixture/events/test',
      shape: 'shape-1',
      body: '{"version":1,"fields":[]}',
    };
    await history.saveInputProjectionPlan(plan);
    expect(
      await history.bindInputProjection({ ...binding, contextHash: 'bad' }),
    ).toBeUndefined();
    expect(await history.bindInputProjection(binding)).toEqual(binding);
    expect(
      await history.bindInputProjection({
        ...binding,
        reference: 'ijklmnop',
        revision: 'new',
      }),
    ).toEqual(binding);
    expect(
      await history.readInputProjection('child', 'abcdefgh'),
    ).toBeUndefined();
    await history.close();
    const restarted = await setup({ directory });
    expect(
      await restarted.history.readInputProjection('default', 'abcdefgh'),
    ).toEqual({ context, binding, plan });
    expect(
      await restarted.history.findInputProjectionPlan(plan.family, plan.shape),
    ).toEqual(plan);
  });
});

describe('snapshot storage', () => {
  it('preserves legacy and additive recall payloads through registered startup and restart', async () => {
    const { history, directory } = await setup();
    const legacy = {
      answer: 'Ada owns deployment.',
      entities: ['Ada'],
      skills: [],
    };
    const additive = {
      ...legacy,
      entitySections: [{ entity: 'Ada', section: 'Work' }],
      skillReferences: [{ skill: 'learning/testing', reference: 'unit' }],
      futureField: { preserved: true },
    };
    const messages = [
      message('question', 'Who owns deployment?'),
      ...[legacy, additive].map((output, index) => ({
        id: `recall-${index}`,
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'recallFromMemory',
            toolCallId: `call-${index}`,
            state: 'output-available',
            input: {},
            output,
          },
        ],
      })),
    ] as ExtendedUIMessage[];
    history.openRecorder(meta()).scheduleSync(() => messages);
    await history.flush();
    await history.close();
    const restarted = await setup({ directory });
    expect(
      (
        await restarted.history.loadWindow('default', {
          fallbackMaxBytes: 100000,
        })
      ).entries.map((entry) => entry.message),
    ).toEqual(messages);
    await restarted.history.close();
    const again = await setup({ directory });
    expect(
      (
        await again.history.loadWindow('default', { fallbackMaxBytes: 100000 })
      ).entries.map((entry) => entry.message),
    ).toEqual(messages);
  });

  it('keeps checkpoint-tail references through restart and evicts by logical bytes', async () => {
    const { history, directory, setMaxBytes } = await setup();
    const annotated = (id: string, body: string) => {
      const value = message(id);
      value.parts.push({
        type: 'data-loadedMemories',
        data: { note: body },
      } as never);
      return value;
    };
    const recorder = history.openRecorder(meta());
    const anchor = annotated('anchor', 'old'.repeat(1000));
    const tail = annotated('tail', 'current'.repeat(1000));
    recorder.scheduleSync(() => [anchor, tail]);
    await history.flush();
    const header = {
      id: 'checkpoint',
      role: 'user',
      parts: [
        { type: CHECKPOINT_PART_TYPE, data: { summary: 'retained summary' } },
      ],
    } as unknown as ExtendedUIMessage;
    await recorder.commitCheckpoint(header, anchor.id, () => [anchor, tail]);
    setMaxBytes(1);
    await history.enforceSizeCap();
    const raw = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      expect(
        (await raw.execute('SELECT content FROM memory_snapshots')).rows.map(
          (row) => row.content,
        ),
      ).toEqual(['current'.repeat(1000)]);
      expect(
        (
          await history.loadWindow('default', { fallbackMaxBytes: 1 })
        ).entries.map((entry) => entry.message),
      ).toEqual([header, tail]);
      await history.close();
      const restarted = await setup({ directory });
      const window = await restarted.history.loadWindow('default', {
        fallbackMaxBytes: 1,
      });
      expect(window.entries.map((entry) => entry.message)).toEqual([
        header,
        tail,
      ]);
      const replacement = restarted.history.openRecorder(meta());
      replacement.seed(window);
      replacement.scheduleSync(() =>
        window.entries.map((entry) => entry.message),
      );
      const before = (
        await raw.execute(
          'SELECT content, content_revision FROM messages ORDER BY ord',
        )
      ).rows;
      await restarted.history.flush();
      expect(
        (
          await raw.execute(
            'SELECT content, content_revision FROM messages ORDER BY ord',
          )
        ).rows,
      ).toEqual(before);
    } finally {
      raw.close();
    }
  });

  it('shares versions across sessions, preserves edits and releases only unreferenced snapshots', async () => {
    const { history, directory } = await setup();
    const raw = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    const annotated = (id: string, body: string) => {
      const value = message(id);
      value.parts.push({
        type: 'data-loadedMemories',
        data: { note: body },
      } as never);
      value.parts.push({
        type: 'data-loadedMemorySections',
        data: { section: body },
      } as never);
      return value;
    };
    try {
      const first = history.openRecorder(meta());
      const second = history.openRecorder(meta({ sessionId: 'other' }));
      let values = [annotated('a', 'before'), annotated('b', 'before')];
      first.scheduleSync(() => values);
      second.scheduleSync(() => [annotated('c', 'before')]);
      await history.flush();
      expect(
        (await raw.execute('SELECT * FROM memory_snapshots')).rows,
      ).toHaveLength(1);
      values = [values[1]!, annotated('inserted', 'after'), values[0]!];
      first.scheduleSync(() => values);
      await history.flush();
      expect(
        (
          await history.loadWindow('default', { fallbackMaxBytes: 1e6 })
        ).entries.map((entry) => entry.message),
      ).toEqual(values);
      expect(
        (await history.readActivity({ maxBytes: 1e6 })).map(
          (entry) => entry.message,
        ),
      ).toEqual(values);
      expect(
        (await history.getMessages(first.instanceId, { limit: 1 }))?.messages[0]
          ?.message,
      ).toEqual(values[2]);
      first.scheduleSync(() => []);
      await history.flush();
      expect(
        (await raw.execute('SELECT content FROM memory_snapshots')).rows.map(
          (row) => row.content,
        ),
      ).toEqual(['before']);
      second.scheduleSync(() => []);
      await history.flush();
      expect(
        (await raw.execute('SELECT * FROM memory_snapshots')).rows,
      ).toHaveLength(0);
    } finally {
      raw.close();
    }
  });

  it('rolls back snapshot insertion atomically on message failure and retries', async () => {
    const { history, directory } = await setup();
    const raw = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      const recorder = history.openRecorder(meta());
      const value = message('atomic');
      value.parts.push({
        type: 'data-loadedMemories',
        data: { note: 'immutable' },
      } as never);
      await raw.execute(
        "CREATE TRIGGER reject_snapshot_message BEFORE INSERT ON messages BEGIN SELECT RAISE(FAIL, 'injected'); END",
      );
      recorder.scheduleSync(() => [value]);
      await history.flush();
      expect(
        (await raw.execute('SELECT * FROM memory_snapshots')).rows,
      ).toHaveLength(0);
      await raw.execute('DROP TRIGGER reject_snapshot_message');
      recorder.scheduleSync(() => [value]);
      await history.flush();
      expect(
        (await history.getMessages(recorder.instanceId, { limit: 10 }))
          ?.messages[0]?.message,
      ).toEqual(value);
    } finally {
      raw.close();
    }
  });

  it.each(['missing', 'corrupt'])(
    'rejects %s snapshot bodies instead of substituting current facts',
    async (mode) => {
      const { history, directory } = await setup();
      const recorder = history.openRecorder(meta());
      const value = message('broken');
      value.parts.push({
        type: 'data-loadedMemories',
        data: { note: 'immutable' },
      } as never);
      recorder.scheduleSync(() => [value]);
      await history.flush();
      const raw = createClient({
        url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
      });
      try {
        await raw.execute(
          mode === 'missing'
            ? 'DELETE FROM memory_snapshots'
            : "UPDATE memory_snapshots SET content = 'changed'",
        );
        await expect(
          history.loadWindow('default', { fallbackMaxBytes: 1e6 }),
        ).rejects.toThrow(/snapshot/);
        await expect(
          history.getMessages(recorder.instanceId, { limit: 10 }),
        ).rejects.toThrow(/snapshot/);
        await expect(history.readActivity({})).rejects.toThrow(/snapshot/);
      } finally {
        raw.close();
      }
    },
  );

  it('migrates a released v4 database without rewriting inline messages and recovers migration failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-history-v4-'));
    directories.push(directory);
    const path = join(directory, SESSION_HISTORY_RELATIVE_PATH);
    const raw = createClient({ url: `file:${path}` });
    await raw.executeMultiple(
      await readFile(
        new URL(
          '../local-data-migration-fixtures/sessions-v3.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await SESSION_HISTORY_STORE_DEFINITION.migrations
      .find((step) => step.to === 4)!
      .up(raw);
    await raw.execute(
      "UPDATE meta SET value = '4' WHERE key = 'schemaVersion'",
    );
    const before = (await raw.execute('SELECT * FROM messages')).rows;
    raw.close();
    const migrate = (store: SqliteStoreDefinition) =>
      createLocalData({
        logging: logger,
        dataDirectory: directory,
        klexVersion: KLEX_VERSION,
        stores: [store],
      }).start();
    await expect(
      migrate({
        ...SESSION_HISTORY_STORE_DEFINITION,
        migrations: SESSION_HISTORY_STORE_DEFINITION.migrations.map((step) =>
          step.to === 5
            ? {
                ...step,
                up: async (client) => {
                  await step.up(client);
                  throw new Error('injected');
                },
              }
            : step,
        ),
      }),
    ).rejects.toThrow(/restored/);
    const restored = createClient({ url: `file:${path}` });
    expect((await restored.execute('SELECT * FROM messages')).rows).toEqual(
      before,
    );
    expect(
      (
        await restored.execute(
          "SELECT name FROM sqlite_master WHERE name = 'memory_snapshots'",
        )
      ).rows,
    ).toHaveLength(0);
    restored.close();
    await migrate(SESSION_HISTORY_STORE_DEFINITION);
    const bytes = await readFile(path);
    await migrate(SESSION_HISTORY_STORE_DEFINITION);
    expect(await readFile(path)).toEqual(bytes);
    await expect(
      migrate({
        ...SESSION_HISTORY_STORE_DEFINITION,
        schemaVersion: 4,
        migrations: SESSION_HISTORY_STORE_DEFINITION.migrations.filter(
          (step) => step.to <= 4,
        ),
      }),
    ).rejects.toThrow(/schema=6.*schema=4/);
    expect(await readFile(path)).toEqual(bytes);
    const migrated = createClient({ url: `file:${path}` });
    expect((await migrated.execute('SELECT * FROM messages')).rows).toEqual(
      before,
    );
    migrated.close();
    const { history } = await setup({ directory });
    expect(
      (await history.loadWindow('default', { fallbackMaxBytes: 1e6 })).entries
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('canonical activity queries', () => {
  it('measures repeated snapshots in SQLite and restores a bounded large window', async () => {
    const { history, directory } = await setup();
    const recorder = history.openRecorder(meta());
    const snapshot = JSON.stringify({
      version: 1,
      kind: 'skill',
      title: 'scale',
      sections: [],
      body: 'current fact '.repeat(2000),
    });
    const values = Array.from({ length: 160 }, (_, index) => {
      const value = message(`snapshot-${index}`);
      value.parts.push({
        type: 'data-loadedMemories',
        data: { 'skills/learning/scale/SKILL.md': snapshot },
      } as never);
      return value;
    });
    recorder.scheduleSync(() => values);
    await history.flush();
    const client = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      const result = await client.execute(
        'SELECT COUNT(*) AS count, SUM(byte_size) AS bytes FROM messages',
      );
      expect(Number(result.rows[0]?.count)).toBe(160);
      const bytes = Number(result.rows[0]?.bytes);
      expect(bytes).toBeGreaterThan(Buffer.byteLength(snapshot) * 160);
      const physical = await client.execute(
        'SELECT SUM(length(CAST(content AS BLOB))) AS bytes FROM messages',
      );
      const snapshots = await client.execute(
        'SELECT COUNT(*) AS count, SUM(length(CAST(content AS BLOB))) AS bytes FROM memory_snapshots',
      );
      expect(Number(snapshots.rows[0]?.count)).toBe(1);
      const physicalBytes =
        Number(physical.rows[0]?.bytes) + Number(snapshots.rows[0]?.bytes);
      expect(physicalBytes).toBeLessThan(bytes / 20);
      const pageCount = Number(
        (await client.execute('PRAGMA page_count')).rows[0]?.page_count,
      );
      const pageSize = Number(
        (await client.execute('PRAGMA page_size')).rows[0]?.page_size,
      );
      console.info('memory snapshot SQLite retention', {
        messages: 160,
        snapshotBytes: Buffer.byteLength(snapshot),
        logicalBytes: bytes,
        physicalBytes,
        allocatedBytes: pageCount * pageSize,
      });
      const window = await history.loadWindow('default', {
        fallbackMaxBytes: 150000,
      });
      expect(window.entries.length).toBeGreaterThan(0);
      expect(window.entries.length).toBeLessThan(160);
      expect(window.entries.at(-1)?.message).toEqual(values.at(-1));
    } finally {
      client.close();
    }
  });
  it('round-trips additive memory and invocation parts across registered startup and recorder resync', async () => {
    const { history, directory } = await setup();
    const recorder = history.openRecorder(meta());
    const value = message('annotated');
    value.parts.push(
      ...([
        {
          type: 'data-loadedMemories',
          data: {
            'skills/learned/example/SKILL.md':
              '{"version":1,"kind":"skill","title":"example","body":"procedure"}',
          },
        },
        { type: 'data-loadedMemorySections', data: {} },
        {
          type: 'data-availableSkills',
          data: [{ name: 'learned/example', description: 'Example skill' }],
        },
        {
          type: 'data-activeSkills',
          data: {
            version: 1,
            window: 'checkpoint-window',
            skills: { 'learned/example': ['guide'] },
          },
        },
        {
          type: 'data-mcpInvocations',
          data: [
            {
              id: 'invocation',
              executionId: 'execution',
              namespace: 'slack',
              name: 'send',
              input: { channel: 'C1' },
            },
          ],
        },
      ] as unknown as ExtendedUIMessage['parts']),
    );
    recorder.scheduleSync(() => [value]);
    await history.flush();
    await history.close();
    const restarted = await setup({ directory });
    const restored = await restarted.history.loadWindow('default', {
      fallbackMaxBytes: 100000,
    });
    expect(restored.entries.map((entry) => entry.message)).toEqual([value]);
    const next = restarted.history.openRecorder(meta());
    next.seed(restored);
    next.scheduleSync(() => restored.entries.map((entry) => entry.message));
    await restarted.history.flush();
    expect(
      (
        await restarted.history.loadWindow('default', {
          fallbackMaxBytes: 100000,
        })
      ).entries.map((entry) => entry.message),
    ).toEqual([value]);
  });
  it('keeps revisions stable across other recorder syncs and restarts', async () => {
    const { history, directory } = await setup();
    const first = history.openRecorder(meta());
    first.scheduleSync(() => [message('first')]);
    await history.flush();
    const [source] = await history.activityManifest();
    const second = history.openRecorder(meta());
    second.scheduleSync(() => [message('second')]);
    await history.flush();
    expect((await history.activityManifest())[0]).toEqual(source);
    await history.close();
    const restarted = await setup({ directory });
    expect((await restarted.history.activityManifest())[0]).toEqual(source);
    const repaired = restarted.history.openRecorder(meta());
    const restored = await restarted.history.loadWindow('default', {
      fallbackMaxBytes: 10000,
    });
    repaired.seed(restored);
    const messages = restored.entries.map((entry) => entry.message);
    // Same-size repairs must change the content revision, not just a size field.
    repaired.scheduleSync(() =>
      messages.map((entry) =>
        entry.id === 'first' ? message('first', 'other') : entry,
      ),
    );
    await restarted.history.flush();
    expect((await restarted.history.activityManifest())[0]?.revision).not.toBe(
      source?.revision,
    );
  });

  it('migrates frozen v3 through registered startup, recovers failure and rejects old writers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-history-v3-'));
    directories.push(directory);
    const path = join(directory, SESSION_HISTORY_RELATIVE_PATH);
    const raw = createClient({ url: `file:${path}` });
    await raw.executeMultiple(
      await readFile(
        new URL(
          '../local-data-migration-fixtures/sessions-v3.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const before = (await raw.execute('SELECT * FROM messages ORDER BY ord'))
      .rows;
    raw.close();
    const migrate = (store: SqliteStoreDefinition) =>
      createLocalData({
        logging: logger,
        dataDirectory: directory,
        klexVersion: KLEX_VERSION,
        stores: [store],
      }).start();
    const broken = {
      ...SESSION_HISTORY_STORE_DEFINITION,
      migrations: SESSION_HISTORY_STORE_DEFINITION.migrations.map((step) =>
        step.to === 4
          ? {
              ...step,
              up: async (client: Parameters<typeof step.up>[0]) => {
                await step.up(client);
                throw new Error('injected revision migration failure');
              },
            }
          : step,
      ),
    };
    await expect(migrate(broken)).rejects.toThrow(/restored/);
    const restored = createClient({ url: `file:${path}` });
    expect(
      (await restored.execute('SELECT * FROM messages ORDER BY ord')).rows,
    ).toEqual(before);
    expect(
      (
        await restored.execute(
          "SELECT value FROM meta WHERE key = 'schemaVersion'",
        )
      ).rows[0]?.value,
    ).toBe('3');
    restored.close();
    const first = await setup({ directory });
    const sources = await first.history.activityManifest();
    expect(sources[0]?.revision).toBe('2026-08-14T10:00:00.000Z:78');
    await first.history.close();
    const migrated = createClient({ url: `file:${path}` });
    const rows = (await migrated.execute('SELECT * FROM messages ORDER BY ord'))
      .rows;
    expect(
      rows.map(({ content_revision, ...row }) => {
        expect(content_revision).toBeNull();
        return row;
      }),
    ).toEqual(before);
    expect(
      (
        await migrated.execute(
          "SELECT value FROM meta WHERE key = 'schemaVersion'",
        )
      ).rows[0]?.value,
    ).toBe('6');
    migrated.close();
    const bytes = await readFile(path);
    await migrate(SESSION_HISTORY_STORE_DEFINITION);
    expect(await readFile(path)).toEqual(bytes);
    await expect(
      migrate({
        ...SESSION_HISTORY_STORE_DEFINITION,
        schemaVersion: 3,
        minimumKlexVersion: '0.26.0',
        migrations: SESSION_HISTORY_STORE_DEFINITION.migrations.filter(
          (step) => step.to <= 3,
        ),
      }),
    ).rejects.toThrow(/schema=6.*schema=3/);
    expect(await readFile(path)).toEqual(bytes);
    const second = await setup({ directory });
    expect(await second.history.activityManifest()).toEqual(sources);
  });

  it('pages across instances, excludes children, and advances oversized sources', async () => {
    const { history } = await setup();
    const first = history.openRecorder(meta());
    const child = history.openRecorder(
      meta({ sessionId: 'child', kind: 'child' }),
    );
    const hints = { count: 0 };
    const detach = history.subscribeActivity(() => hints.count++);
    first.scheduleSync(() => [message('one', 'first', 'assistant')]);
    child.scheduleSync(() => [message('hidden', 'secret', 'assistant')]);
    await history.flush();
    const second = history.openRecorder(meta());
    second.scheduleSync(() => [message('two', 'second', 'assistant')]);
    await history.flush();
    const manifest = await history.activityManifest();
    expect(manifest).toHaveLength(2);
    expect(manifest[1]!.ordinal).toBeGreaterThan(manifest[0]!.ordinal);
    const page = await history.readActivity({ limit: 1, maxBytes: 1 });
    expect(page[0]?.message).toBeNull();
    expect(
      (await history.readActivity({ after: page[0]!.ordinal }))[0]?.message?.id,
    ).toBe('two');
    expect(hints.count).toBeGreaterThan(0);
    detach();
  });

  it('reflects same-size repairs and rollback deletion in manifests', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('one', 'before', 'assistant')]);
    await history.flush();
    const before = (await history.activityManifest())[0]!;
    recorder.scheduleSync(() => [message('one', 'after!', 'assistant')]);
    await history.flush();
    expect((await history.activityManifest())[0]!.revision).not.toBe(
      before.revision,
    );
    recorder.scheduleSync(() => []);
    await history.flush();
    expect(await history.activityManifest()).toEqual([]);
  });
});

describe('resolveSessionHistoryMaxBytes', () => {
  it('uses the default unless the config overrides it', () => {
    const config = klexConfigSchema.parse({});
    expect(resolveSessionHistoryMaxBytes(config)).toBe(
      DEFAULT_SESSION_HISTORY_MAX_BYTES,
    );
    expect(
      resolveSessionHistoryMaxBytes({
        ...config,
        sessionHistory: { maxBytes: 32 * 1024 * 1024 },
      }),
    ).toBe(32 * 1024 * 1024);
  });
});

describe('session history sync', () => {
  it.each(['{broken', '{"category":"rate_limit"}', 'null', '[]'])(
    'ignores invalid stored generation health (%s) and replaces it',
    async (value) => {
      const { history, directory } = await setup();
      const recorder = history.openRecorder(meta());
      const failure = summarizeGenerationFailure(
        new Error('rate limit TPM: 30000'),
      );
      await recorder.recordGenerationFailure(failure, 'turn_failed', 1);
      const raw = createClient({
        url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
      });
      try {
        await raw.execute({
          sql: 'UPDATE sessions SET generation_error = ? WHERE instance_id = ?',
          args: [value, recorder.instanceId],
        });
        expect(
          (await history.getSession(recorder.instanceId))?.generationError,
        ).toBeNull();
        expect(
          (await history.listSessions({ limit: 10 })).sessions,
        ).toMatchObject([
          { instanceId: recorder.instanceId, generationError: null },
        ]);
        await expect(
          recorder.recordGenerationFailure(failure, 'turn_failed', 2),
        ).resolves.toBeUndefined();
        expect(
          (await history.getSession(recorder.instanceId))?.generationError,
        ).toMatchObject({
          ...failure,
          consecutiveFailures: 2,
          occurrenceCount: 1,
        });
      } finally {
        raw.close();
      }
    },
  );

  it('does not reject generation health writes when SQLite rejects updates or the store is closed', async () => {
    const { history, directory } = await setup();
    const recorder = history.openRecorder(meta());
    const failure = summarizeGenerationFailure(new Error('rate limit'));
    await recorder.recordGenerationFailure(failure, 'turn_failed', 1);
    const raw = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      await raw.execute(`CREATE TRIGGER reject_health BEFORE UPDATE ON sessions
        BEGIN SELECT RAISE(FAIL, 'injected write failure'); END`);
      await expect(
        recorder.recordGenerationFailure(failure, 'turn_failed', 2),
      ).resolves.toBeUndefined();
      await expect(recorder.clearGenerationFailure()).resolves.toBeUndefined();
      expect(
        (await history.getSession(recorder.instanceId))?.generationError
          ?.occurrenceCount,
      ).toBe(1);
    } finally {
      raw.close();
    }
    await history.close();
    await expect(
      recorder.recordGenerationFailure(failure, 'turn_failed', 3),
    ).resolves.toBeUndefined();
    await expect(recorder.clearGenerationFailure()).resolves.toBeUndefined();
  });

  it('retains unresolved warning metadata when the size cap evicts its transcript', async () => {
    const { history, setMaxBytes } = await setup();
    const recorder = history.openRecorder(
      meta({ kind: 'child', sessionId: 'child' }),
    );
    recorder.scheduleSync(() => [message('large', 'x'.repeat(1000))]);
    await recorder.recordGenerationFailure(
      summarizeGenerationFailure(new Error('rate limit')),
      'terminated',
      5,
    );
    await recorder.end('failed');
    setMaxBytes(1);
    await history.enforceSizeCap();
    expect(await history.getSession(recorder.instanceId)).toMatchObject({
      byteSize: 0,
      trimmedMessageCount: 1,
      generationError: { kind: 'terminated' },
    });
    expect(await storedIds(history, recorder.instanceId)).toEqual([]);
  });

  it('supersedes warnings with tied instance timestamps and resets counts for a different failure', async () => {
    const { history } = await setup();
    const createdAt = '2026-01-01T00:00:00.000Z';
    const old = history.openRecorder(meta({ createdAt }));
    const replacement = history.openRecorder(meta({ createdAt }));
    const failure = summarizeGenerationFailure(new Error('rate limit'));
    await old.recordGenerationFailure(failure, 'turn_failed', 1);
    await replacement.recordGenerationFailure(failure, 'turn_failed', 1);
    await old.clearGenerationFailure();
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).toBeNull();
    expect(
      (await history.getSession(replacement.instanceId))?.generationError,
    ).not.toBeNull();
    // A late failure is a newer occurrence, so there must still be only one warning.
    await old.recordGenerationFailure(failure, 'turn_failed', 2);
    expect(
      (await history.getSession(replacement.instanceId))?.generationError,
    ).toBeNull();
    await old.recordGenerationFailure(
      summarizeGenerationFailure(new Error('billing quota exhausted')),
      'turn_failed',
      3,
    );
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).toMatchObject({ category: 'quota', occurrenceCount: 1 });
    await replacement.clearGenerationFailure();
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).toBeNull();
  });

  it('migrates v2 additively, restores failed migrations, and rejects downgrade writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-history-v2-'));
    directories.push(directory);
    const v2: SqliteStoreDefinition = {
      ...SESSION_HISTORY_STORE_DEFINITION,
      schemaVersion: 2,
      minimumKlexVersion: '0.23.0',
      initSql: SESSION_HISTORY_INIT_SQL.replace(
        '  generation_error TEXT,\n',
        '',
      )
        .replace('  content_revision TEXT,\n', '')
        .replace(/CREATE TABLE input_projection_plans[\s\S]*$/, ''),
      migrations: SESSION_HISTORY_STORE_DEFINITION.migrations.filter(
        (migration) => migration.to <= 2,
      ),
      validate: async (client) => {
        await client.execute('SELECT instance_id FROM sessions LIMIT 1');
      },
    };
    const migrate = (store: SqliteStoreDefinition) =>
      createLocalData({
        logging: logger,
        dataDirectory: directory,
        klexVersion: KLEX_VERSION,
        stores: [store],
      }).start();
    await migrate(v2);
    const raw = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    await raw.execute(
      "INSERT INTO sessions (instance_id, session_id, kind, name, created_at, updated_at) VALUES ('old', 'default', 'default', 'old', '2026-01-01', '2026-01-01')",
    );
    raw.close();
    const broken: SqliteStoreDefinition = {
      ...SESSION_HISTORY_STORE_DEFINITION,
      migrations: [
        ...v2.migrations,
        {
          from: 2,
          to: 3,
          name: 'failure',
          up: async (db) => {
            await db.execute(
              'ALTER TABLE sessions ADD COLUMN generation_error TEXT',
            );
            throw new Error('injected migration failure');
          },
        },
        ...SESSION_HISTORY_STORE_DEFINITION.migrations.filter(
          (migration) => migration.from >= 3,
        ),
      ],
    };
    await expect(migrate(broken)).rejects.toThrow(/restored/);
    await migrate(v2);
    await migrate(SESSION_HISTORY_STORE_DEFINITION);
    const { history } = await setup({ directory });
    expect(await history.getSession('old')).toMatchObject({
      generationError: null,
      name: 'old',
    });
    await history.close();
    await expect(migrate(v2)).rejects.toThrow(/schema=6.*schema=2/);
  });

  it('persists and deduplicates zero-message failures through sync, end, and restart', async () => {
    const { history, directory } = await setup();
    const recorder = history.openRecorder(meta());
    const failure = summarizeGenerationFailure(
      new Error('rate limit TPM: 30000'),
    );
    await recorder.recordGenerationFailure(failure, 'turn_failed', 1);
    const first = (await history.getSession(recorder.instanceId))
      ?.generationError;
    expect(first).toMatchObject({ occurrenceCount: 1, consecutiveFailures: 1 });
    for (let count = 2; count <= 5; count++)
      await recorder.recordGenerationFailure(
        failure,
        count === 5 ? 'terminated' : 'turn_failed',
        count,
      );
    recorder.scheduleSync(() => []);
    await recorder.end('max_consecutive_failures');
    await history.close();
    const reopened = await setup({ directory });
    expect(
      await reopened.history.getSession(recorder.instanceId),
    ).toMatchObject({
      live: false,
      messageCount: 0,
      generationError: {
        kind: 'terminated',
        occurrenceCount: 5,
        consecutiveFailures: 5,
        firstSeenAt: first?.firstSeenAt,
      },
    });
  });

  it('retains an ended failure until replacement failure or success, independently of child sessions', async () => {
    const { history } = await setup();
    const old = history.openRecorder(
      meta({ createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    const child = history.openRecorder(
      meta({ sessionId: 'child', kind: 'child' }),
    );
    const failure = summarizeGenerationFailure(new Error('rate limit'));
    await old.recordGenerationFailure(failure, 'terminated', 5);
    await old.end('failed');
    await child.recordGenerationFailure(failure, 'request_rejected', 1);
    const replacement = history.openRecorder(
      meta({ createdAt: '2026-01-02T00:00:00.000Z' }),
    );
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).not.toBeNull();
    await replacement.recordGenerationFailure(failure, 'turn_failed', 1);
    expect(
      (await history.getSession(old.instanceId))?.generationError,
    ).toBeNull();
    replacement.scheduleSync(() => [message('after-failure')]);
    await history.flush();
    expect(
      (await history.getSession(replacement.instanceId))?.messageCount,
    ).toBe(1);
    await replacement.end('failed');
    const recovered = history.openRecorder(
      meta({ createdAt: '2026-01-03T00:00:00.000Z' }),
    );
    await recovered.clearGenerationFailure();
    expect(
      (await history.getSession(replacement.instanceId))?.generationError,
    ).toBeNull();
    expect(
      (await history.getSession(child.instanceId))?.generationError,
    ).not.toBeNull();
  });

  it('persists in-place mutations of older messages', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const repaired = message('a', 'pending', 'assistant');
    const messages = [repaired, message('b')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    // History repair mutates an older message after newer input arrived.
    repaired.parts = [{ type: 'text', text: 'repaired' }];
    messages.push(message('c'));
    recorder.scheduleSync(() => messages);
    await history.flush();

    const page = await history.getMessages(recorder.instanceId, { limit: 10 });
    expect(page?.messages.map((entry) => entry.message.parts)).toEqual([
      [{ type: 'text', text: 'repaired' }],
      [{ type: 'text', text: 'b' }],
      [{ type: 'text', text: 'c' }],
    ]);
  });

  it('lazily inserts the session and appends messages', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta({ name: 'Main' }));
    await history.flush();
    expect(await history.getSession(recorder.instanceId)).toBeUndefined();

    const messages = [message('a'), message('b')];
    recorder.scheduleSync(() => messages);
    await history.flush();
    messages.push(message('c'));
    recorder.scheduleSync(() => messages);
    await history.flush();

    expect(await storedIds(history, recorder.instanceId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const session = await history.getSession(recorder.instanceId);
    expect(session).toMatchObject({
      name: 'Main',
      kind: 'default',
      live: true,
      messageCount: 3,
      trimmedMessageCount: 0,
    });
    expect(session?.byteSize).toBeGreaterThan(0);
  });

  it('rewrites from a mid-history insert and handles truncation', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a'), message('b'), message('c')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    messages.splice(1, 0, message('x'));
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual([
      'a',
      'x',
      'b',
      'c',
    ]);

    messages.splice(2, 2);
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'x']);
    expect((await history.getSession(recorder.instanceId))?.messageCount).toBe(
      2,
    );
  });

  it('captures in-place mutations of the last message', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const last = message('a', 'partial');
    const messages = [last];
    recorder.scheduleSync(() => messages);
    await history.flush();

    Object.assign(last, { parts: [{ type: 'text', text: 'complete' }] });
    recorder.scheduleSync(() => messages);
    await history.flush();

    const page = await history.getMessages(recorder.instanceId, { limit: 10 });
    expect(page?.messages[0]?.message.parts).toEqual([
      { type: 'text', text: 'complete' },
    ]);
  });

  it('coalesces concurrent schedules into one snapshot', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages: ExtendedUIMessage[] = [];
    let reads = 0;
    const getter = () => {
      reads++;
      return messages;
    };
    for (let index = 0; index < 5; index++) {
      messages.push(message(`m${index}`));
      recorder.scheduleSync(getter);
    }
    await history.flush();
    expect(reads).toBe(1);
    expect(await storedIds(history, recorder.instanceId)).toHaveLength(5);
  });

  it('retries after a failed sync without throwing', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a')];
    recorder.scheduleSync(() => {
      throw new Error('boom');
    });
    await history.flush();
    expect(await history.getSession(recorder.instanceId)).toBeUndefined();

    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a']);
  });

  it('runs a final sync on end and records the reason', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a')];
    recorder.scheduleSync(() => messages);
    await history.flush();
    messages.push(message('b'));
    await recorder.end('closed');

    const session = await history.getSession(recorder.instanceId);
    expect(session).toMatchObject({ live: false, endReason: 'closed' });
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'b']);

    recorder.scheduleSync(() => [...messages, message('c')]);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'b']);
  });

  it('marks unfinished sessions as unclean shutdown on startup', async () => {
    const first = await setup();
    const recorder = first.history.openRecorder(meta());
    recorder.scheduleSync(() => [message('a')]);
    await first.history.close();

    const second = await setup({ directory: first.directory });
    const session = await second.history.getSession(recorder.instanceId);
    expect(session).toMatchObject({
      live: false,
      endReason: 'unclean_shutdown',
    });
  });

  it('drains writes enqueued while closing', async () => {
    const first = await setup();
    const recorder = first.history.openRecorder(meta());
    const messages = [message('a')];
    recorder.scheduleSync(() => messages);
    const closing = first.history.close();
    messages.push(message('b'));
    const ending = recorder.end('closed');
    await Promise.all([closing, ending]);

    const second = await setup({ directory: first.directory });
    expect(await second.history.getSession(recorder.instanceId)).toMatchObject({
      live: false,
      endReason: 'closed',
    });
    expect(await storedIds(second.history, recorder.instanceId)).toEqual([
      'a',
      'b',
    ]);
  });

  it.each(['schemaVersion', 'compatibilityVersion'])(
    'rejects a store with a newer %s without mutating it',
    async (key) => {
      const first = await setup();
      const recorder = first.history.openRecorder(meta());
      recorder.scheduleSync(() => [message('a')]);
      await first.history.close();

      const raw = createClient({
        url: `file:${join(first.directory, SESSION_HISTORY_RELATIVE_PATH)}`,
      });
      const snapshot = async () =>
        JSON.stringify([
          (await raw.execute('SELECT key, value FROM meta ORDER BY key')).rows,
          (await raw.execute('SELECT * FROM sessions ORDER BY instance_id'))
            .rows,
          (await raw.execute('SELECT * FROM messages ORDER BY session_id, ord'))
            .rows,
        ]);
      try {
        await raw.execute({
          sql: 'UPDATE meta SET value = ? WHERE key = ?',
          args: ['99', key],
        });
        const before = await snapshot();

        const config = klexConfigSchema.parse({});
        const history = createSessionHistory({
          logging: logger,
          dataDirectory: first.directory,
          config: { get: () => config },
        });
        modules.push(history);
        await expect(history.start()).rejects.toThrow();
        expect(await snapshot()).toBe(before);
      } finally {
        raw.close();
      }
    },
  );

  it('can start again after a failed start', async () => {
    const first = await setup();
    await first.history.close();

    // Hold the write lock so the startup recovery UPDATE fails.
    const blocker = createClient({
      url: `file:${join(first.directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    await blocker.execute('BEGIN EXCLUSIVE');
    const config = klexConfigSchema.parse({});
    const history = createSessionHistory({
      logging: logger,
      dataDirectory: first.directory,
      config: { get: () => config },
    });
    modules.push(history);
    try {
      await expect(history.start()).rejects.toThrow();
    } finally {
      await blocker.execute('ROLLBACK');
      blocker.close();
    }

    await history.start();
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('a')]);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a']);
  });
});

describe('session history size cap', () => {
  function bulky(id: string): ExtendedUIMessage {
    return message(id, 'x'.repeat(1_000));
  }

  it('evicts ended sessions before trimming live ones', async () => {
    const { history, setMaxBytes } = await setup();
    const ended = history.openRecorder(meta({ kind: 'child', sessionId: 'c' }));
    ended.scheduleSync(() => [bulky('e1'), bulky('e2')]);
    await ended.end('closed');
    const live = history.openRecorder(meta());
    live.scheduleSync(() => [bulky('l1'), bulky('l2')]);
    await history.flush();

    const liveBytes =
      (await history.getSession(live.instanceId))?.byteSize ?? 0;
    setMaxBytes(Math.ceil(liveBytes / 0.9) + 10);
    await history.enforceSizeCap();

    expect(await history.getSession(ended.instanceId)).toBeUndefined();
    expect(await storedIds(history, live.instanceId)).toEqual(['l1', 'l2']);
  });

  it('trims live messages oldest first and never restores trimmed rows', async () => {
    const { history, setMaxBytes } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [bulky('a'), bulky('b'), bulky('c')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    const bytes = (await history.getSession(recorder.instanceId))?.byteSize;
    // Room for one message after eviction to 90% of the cap.
    setMaxBytes(Math.ceil(((bytes ?? 0) / 3 + 10) / 0.9));
    await history.enforceSizeCap();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['c']);
    const session = await history.getSession(recorder.instanceId);
    expect(session).toMatchObject({ trimmedMessageCount: 2, messageCount: 3 });

    setMaxBytes(DEFAULT_SESSION_HISTORY_MAX_BYTES);
    // A mid-window insert takes the next `ord`; known rows that now follow
    // it move to fresh `ord`s. Evicted rows (`b`) stay evicted.
    messages.splice(1, 0, bulky('x'));
    recorder.scheduleSync(() => messages);
    await history.flush();
    const page = await history.getMessages(recorder.instanceId, { limit: 10 });
    expect(
      page?.messages.map((entry) => [entry.seq, entry.message.id]),
    ).toEqual([
      [3, 'x'],
      [5, 'c'],
    ]);
    expect(page?.trimmedMessageCount).toBe(2);
  });

  it('trims the newest live message when it alone exceeds the cap', async () => {
    const { history, setMaxBytes } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [bulky('a'), bulky('b')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    setMaxBytes(1);
    await history.enforceSizeCap();
    expect(await storedIds(history, recorder.instanceId)).toEqual([]);
    expect(await history.getSession(recorder.instanceId)).toMatchObject({
      trimmedMessageCount: 2,
      messageCount: 2,
      byteSize: 0,
    });

    // New messages are recorded again once there is room.
    setMaxBytes(DEFAULT_SESSION_HISTORY_MAX_BYTES);
    messages.push(message('c'));
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['c']);
  });

  it('reclaims pages with incremental vacuum', async () => {
    const { directory, history, setMaxBytes } = await setup();
    for (let index = 0; index < 5; index++) {
      const recorder = history.openRecorder(meta({ kind: 'child' }));
      recorder.scheduleSync(() =>
        Array.from({ length: 20 }, (_, n) => bulky(`${index}-${n}`)),
      );
      await recorder.end('closed');
    }
    const client = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      const pagesBefore = Number(
        (await client.execute('PRAGMA page_count')).rows[0]?.page_count,
      );
      setMaxBytes(1);
      await history.enforceSizeCap();
      const pagesAfter = Number(
        (await client.execute('PRAGMA page_count')).rows[0]?.page_count,
      );
      const freelist = Number(
        (await client.execute('PRAGMA freelist_count')).rows[0]?.freelist_count,
      );
      expect(pagesAfter).toBeLessThan(pagesBefore);
      expect(freelist).toBe(0);
    } finally {
      client.close();
    }
  });
});

function header(id: string, summary = 'summary'): ExtendedUIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: CHECKPOINT_PART_TYPE, data: { summary } }],
  } as unknown as ExtendedUIMessage;
}

async function windowIds(history: SessionHistory, sessionId = 'default') {
  const window = await history.loadWindow(sessionId, {
    fallbackMaxBytes: 1024 * 1024,
  });
  return window.entries.map((entry) => entry.message.id);
}

describe('session history log', () => {
  it('continues ord across instances of the same logical session', async () => {
    const { history } = await setup();
    const first = history.openRecorder(meta());
    first.scheduleSync(() => [message('a'), message('b', 'b', 'assistant')]);
    await first.end('replaced');
    const second = history.openRecorder(meta());
    second.scheduleSync(() => [message('c')]);
    await history.flush();

    const page = await history.getMessages(second.instanceId, { limit: 10 });
    expect(page?.messages.map((entry) => entry.seq)).toEqual([2]);
    expect(await windowIds(history)).toEqual(['a', 'b', 'c']);
  });

  it('deletes rolled-back messages but keeps trimmed ones', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a'), message('b'), message('c')];
    recorder.scheduleSync(() => messages);
    await history.flush();

    // Rollback: removed without a trim announcement.
    messages.pop();
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'b']);

    // Trim: announced, so the row stays in the log.
    recorder.markTrimmed(['a']);
    messages.shift();
    recorder.scheduleSync(() => messages);
    await history.flush();
    expect(await storedIds(history, recorder.instanceId)).toEqual(['a', 'b']);
    expect((await history.getSession(recorder.instanceId))?.messageCount).toBe(
      2,
    );
  });

  it('commits a checkpoint and restores header plus tail', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [
      message('a'),
      message('b', 'b', 'assistant'),
      message('c'),
      message('d', 'd', 'assistant'),
    ];
    recorder.scheduleSync(() => messages);
    await history.flush();

    const checkpoint = header('h1');
    await recorder.commitCheckpoint(checkpoint, 'b', () => messages);
    recorder.markTrimmed(['a', 'b']);
    messages.splice(0, 2, checkpoint);
    messages.push(message('e'));
    recorder.scheduleSync(() => messages);
    await history.flush();

    // The header is not re-inserted and trimmed rows stay in the log.
    expect(await storedIds(history, recorder.instanceId)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'h1',
      'e',
    ]);
    const window = await history.loadWindow('default', {
      fallbackMaxBytes: 1,
    });
    expect(window.hasCheckpoint).toBe(true);
    expect(window.entries.map((entry) => entry.message.id)).toEqual([
      'h1',
      'c',
      'd',
      'e',
    ]);
    expect(window.entries[0]?.isCheckpoint).toBe(true);
  });

  it('rejects a checkpoint whose anchor is not in the window', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [message('a'), message('b')];
    await expect(
      recorder.commitCheckpoint(header('h1'), 'missing', () => messages),
    ).rejects.toThrow(/not persisted/);
    expect(await windowIds(history)).toEqual(['a', 'b']);
  });

  it('seeds a restored window without re-inserting it', async () => {
    const first = await setup();
    const old = first.history.openRecorder(meta());
    const messages = [message('a'), message('b'), message('c')];
    old.scheduleSync(() => messages);
    const checkpoint = header('h1');
    await old.commitCheckpoint(checkpoint, 'a', () => messages);
    await old.end('closed');
    await first.history.close();

    const second = await setup({ directory: first.directory });
    const window = await second.history.loadWindow('default', {
      fallbackMaxBytes: 1,
    });
    const recorder = second.history.openRecorder(meta());
    recorder.seed(window);
    const restored = window.entries.map((entry) => entry.message);
    restored.push(message('d'));
    recorder.scheduleSync(() => restored);
    await second.history.flush();

    expect(await storedIds(second.history, recorder.instanceId)).toEqual(['d']);
    expect(await storedIds(second.history, old.instanceId)).toEqual([
      'a',
      'b',
      'c',
      'h1',
    ]);
    expect(await windowIds(second.history)).toEqual(['h1', 'b', 'c', 'd']);

    const oldCount = async () =>
      (await second.history.getSession(old.instanceId))?.messageCount;
    expect(await oldCount()).toBe(4);

    // Rolling back a restored message deletes the old instance's row and
    // keeps that instance's count in step.
    restored.splice(1, 1);
    recorder.scheduleSync(() => restored);
    await second.history.flush();
    expect(await windowIds(second.history)).toEqual(['h1', 'c', 'd']);
    expect(await oldCount()).toBe(3);
    expect(
      (await second.history.getSession(recorder.instanceId))?.messageCount,
    ).toBe(1);
  });

  it('falls back to the newest messages within the byte budget', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = [
      message('a', 'x'.repeat(500)),
      message('b', 'x'.repeat(500), 'assistant'),
      message('c', 'x'.repeat(500), 'assistant'),
      message('d', 'x'.repeat(500)),
      message('e', 'x'.repeat(500), 'assistant'),
    ];
    recorder.scheduleSync(() => messages);
    await history.flush();

    const window = await history.loadWindow('default', {
      fallbackMaxBytes: 2_000,
    });
    // Budget fits c, d, e; the window starts at the first user message.
    expect(window.hasCheckpoint).toBe(false);
    expect(window.entries.map((entry) => entry.message.id)).toEqual(['d', 'e']);
  });

  it('never evicts the protected default-session window', async () => {
    const { history, setMaxBytes } = await setup();
    const old = history.openRecorder(meta());
    const messages = [bulkyMessage('a'), bulkyMessage('b'), bulkyMessage('c')];
    old.scheduleSync(() => messages);
    await old.commitCheckpoint(header('h1'), 'a', () => messages);
    await old.end('replaced');
    const child = history.openRecorder(
      meta({ kind: 'child', sessionId: 'child' }),
    );
    child.scheduleSync(() => [bulkyMessage('x')]);
    await child.end('closed');

    setMaxBytes(1);
    await history.enforceSizeCap();

    expect(await history.getSession(child.instanceId)).toBeUndefined();
    expect(await storedIds(history, old.instanceId)).toEqual(['b', 'c', 'h1']);
    expect(await windowIds(history)).toEqual(['h1', 'b', 'c']);
  });
});

function bulkyMessage(id: string): ExtendedUIMessage {
  return message(id, 'x'.repeat(1_000));
}

describe('session history v1 migration', () => {
  const V1_INIT_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  instance_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_instance_id TEXT,
  extension_identifier TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  trimmed_message_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  instance_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  persisted_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, seq)
);
`;
  const V1_DEFINITION: SqliteStoreDefinition = {
    ...SESSION_HISTORY_STORE_DEFINITION,
    schemaVersion: 1,
    compatibilityVersion: 1,
    minimumKlexVersion: '0.14.0',
    initSql: V1_INIT_SQL,
    migrations: [],
    validate: async () => {},
  };

  it('backfills ord per logical session and converts legacy summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-session-history-'));
    directories.push(directory);
    await createLocalData({
      logging: logger,
      dataDirectory: directory,
      klexVersion: KLEX_VERSION,
      stores: [V1_DEFINITION],
    }).start();

    const raw = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    const sessions: [string, string, string, string][] = [
      // instance, session, kind, created_at (out of insertion order)
      ['i2', 'default', 'default', '2026-01-02T00:00:00.000Z'],
      ['i1', 'default', 'default', '2026-01-01T00:00:00.000Z'],
      ['c1', 'child-1', 'child', '2026-01-01T12:00:00.000Z'],
    ];
    const rows: [string, number, string, string, string][] = [
      ['i1', 0, 'a', 'user', JSON.stringify(message('a'))],
      [
        'i1',
        1,
        'b',
        'assistant',
        JSON.stringify(message('b', 'b', 'assistant')),
      ],
      [
        'i1',
        2,
        's',
        'assistant',
        JSON.stringify({
          id: 's',
          role: 'assistant',
          parts: [{ type: CHECKPOINT_PART_TYPE, data: { summary: 'old' } }],
        }),
      ],
      ['i1', 3, 'c', 'user', JSON.stringify(message('c'))],
      ['i2', 0, 'd', 'user', JSON.stringify(message('d'))],
      ['c1', 0, 'x', 'user', JSON.stringify(message('x'))],
    ];
    try {
      for (const [instanceId, sessionId, kind, createdAt] of sessions) {
        await raw.execute({
          sql: `INSERT INTO sessions (instance_id, session_id, kind, name, created_at, updated_at, ended_at)
                VALUES (?, ?, ?, 'n', ?, ?, ?)`,
          args: [instanceId, sessionId, kind, createdAt, createdAt, createdAt],
        });
      }
      for (const [instanceId, seq, id, role, content] of rows) {
        await raw.execute({
          sql: `INSERT INTO messages (instance_id, seq, message_id, role, content, byte_size, persisted_at)
                VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
          args: [instanceId, seq, id, role, content, content.length],
        });
      }
    } finally {
      raw.close();
    }

    const { history } = await setup({ directory });
    const migrated = createClient({
      url: `file:${join(directory, SESSION_HISTORY_RELATIVE_PATH)}`,
    });
    try {
      const result = await migrated.execute(
        `SELECT session_id, ord, message_id, is_checkpoint, covers_through_ord
         FROM messages ORDER BY session_id, ord`,
      );
      expect(
        result.rows.map((row) => [
          row.session_id,
          Number(row.ord),
          row.message_id,
          Number(row.is_checkpoint),
          row.covers_through_ord === null
            ? null
            : Number(row.covers_through_ord),
        ]),
      ).toEqual([
        ['child-1', 0, 'x', 0, null],
        ['default', 0, 'a', 0, null],
        ['default', 1, 'b', 0, null],
        ['default', 2, 's', 1, 1],
        ['default', 3, 'c', 0, null],
        ['default', 4, 'd', 0, null],
      ]);
      const header = await migrated.execute(
        `SELECT role, content, byte_size FROM messages WHERE message_id = 's'`,
      );
      const row = header.rows[0];
      expect(row?.role).toBe('user');
      expect(JSON.parse(String(row?.content)).role).toBe('user');
      expect(Number(row?.byte_size)).toBe(
        Buffer.byteLength(String(row?.content)),
      );
    } finally {
      migrated.close();
    }
    expect(await windowIds(history)).toEqual(['s', 'c', 'd']);

    // New writes continue after the migrated log.
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('e')]);
    await history.flush();
    const page = await history.getMessages(recorder.instanceId, { limit: 1 });
    expect(page?.messages[0]?.seq).toBe(5);
  });
});

describe('session history reads', () => {
  it('pages sessions newest first with filters', async () => {
    const { history } = await setup();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const recorder = history.openRecorder(
        meta({
          kind: index === 4 ? 'god' : 'default',
          createdAt: new Date(base + index * 1000).toISOString(),
        }),
      );
      recorder.scheduleSync(() => [message(`m${index}`)]);
      ids.push(recorder.instanceId);
    }
    await history.flush();

    const first = await history.listSessions({ kind: 'default', limit: 2 });
    expect(first.sessions.map((session) => session.instanceId)).toEqual([
      ids[3],
      ids[2],
    ]);
    expect(first.hasMore).toBe(true);
    const second = await history.listSessions({
      kind: 'default',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.sessions.map((session) => session.instanceId)).toEqual([
      ids[1],
      ids[0],
    ]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });

    const main = await history.listSessions({
      kind: 'default',
      live: true,
      limit: 1,
    });
    expect(main.sessions[0]?.instanceId).toBe(ids[3]);

    await expect(
      history.listSessions({ limit: 1, cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidSessionHistoryCursorError);
  });

  it('filters children by parent instance', async () => {
    const { history } = await setup();
    const parent = history.openRecorder(meta());
    const child = history.openRecorder(
      meta({ kind: 'child', parentInstanceId: parent.instanceId }),
    );
    parent.scheduleSync(() => [message('p')]);
    child.scheduleSync(() => [message('c')]);
    await history.flush();
    const page = await history.listSessions({
      parentInstanceId: parent.instanceId,
      limit: 10,
    });
    expect(page.sessions.map((session) => session.instanceId)).toEqual([
      child.instanceId,
    ]);
  });

  it('pages messages backwards in chronological order', async () => {
    const { history } = await setup();
    const recorder = history.openRecorder(meta());
    const messages = Array.from({ length: 5 }, (_, index) =>
      message(`m${index}`),
    );
    recorder.scheduleSync(() => messages);
    await history.flush();

    const newest = await history.getMessages(recorder.instanceId, { limit: 2 });
    expect(newest?.messages.map((entry) => entry.message.id)).toEqual([
      'm3',
      'm4',
    ]);
    expect(newest).toMatchObject({ hasMore: true, nextCursor: 3 });
    const older = await history.getMessages(recorder.instanceId, {
      limit: 10,
      beforeSeq: newest?.nextCursor ?? undefined,
    });
    expect(older?.messages.map((entry) => entry.message.id)).toEqual([
      'm0',
      'm1',
      'm2',
    ]);
    expect(older).toMatchObject({ hasMore: false, nextCursor: null });
    expect(await history.getMessages('unknown', { limit: 1 })).toBeUndefined();
  });
});

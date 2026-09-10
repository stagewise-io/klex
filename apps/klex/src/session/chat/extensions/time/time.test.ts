import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '../../message-types';
import { convertToModelMessagesExtended } from '../../utils/convert-to-model-messages';
import { createContextCompactionExt } from '../context-compaction';
import {
  createDataPart,
  type ExtensionDeps,
  type ProvisionalStepContext,
} from '../extension-api';
import { createTimeExt, type TimeExtConfig } from './time';

vi.mock('../context-compaction/compaction-prompt.md', () => ({
  default: 'Compaction prompt',
}));

vi.mock('./system-prompt.md', () => ({
  default: 'Time system prompt',
}));

const TIME_KEY = 'time';
const TIMEZONE_KEY = 'timezone';

/** Extracts and asserts a data part transformer from an extension. */
function getTransformer(
  ext: ReturnType<ReturnType<typeof createTimeExt>['create']>,
  key: string,
) {
  const transformer = ext.dataPartTransformers?.[key];
  if (!transformer) throw new Error(`${key} transformer not registered`);
  return transformer;
}

// --- Fixed timestamps (UTC) ---
// Sunday, 12.4.2026, 15:30 UTC
const TS_SUN_1530 = 1_776_007_800;
// Sunday, 12.4.2026, 16:45 UTC
const TS_SUN_1645 = 1_776_012_300;
// Monday, 13.4.2026, 9:00 UTC
const TS_MON_0900 = 1_776_070_800;

const DEFAULT_CONFIG: TimeExtConfig = { timeUpdatePeriod: 300 };

// --- helpers ---

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'time-ext-test-'));
}

function timezonePath(dataDirectory: string): string {
  return join(
    dataDirectory,
    'extensions',
    'io.stagewise',
    'time',
    'timezone.json',
  );
}

function writeLegacyTimezone(dataDirectory: string, source: string): void {
  const path = timezonePath(dataDirectory);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, source);
}

function makeTimeMessage(timestamp: number, tz = 'UTC'): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'data-time', data: { timestamp, tz } }],
  } as unknown as ExtendedUIMessage;
}

function makeTimeAndTimezoneMessage(
  timestamp: number,
  tz = 'UTC',
): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'user',
    parts: [
      { type: 'data-time', data: { timestamp, tz } },
      { type: 'data-timezone', data: { tz, timestamp } },
    ],
  } as unknown as ExtendedUIMessage;
}

function makeTextMessage(text: string): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    parts: [{ type: 'text', text }],
  } as unknown as ExtendedUIMessage;
}

function makeSummaryMessage(summary: string): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'user',
    parts: [createDataPart('context-summary', { summary }) as never],
  };
}

function makeUserMessage(text: string): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  } as unknown as ExtendedUIMessage;
}

function makeDeps(
  overrides?: Partial<ExtensionDeps> & {
    getDataDir?: () => string;
  },
): ExtensionDeps {
  const dataDirectory =
    overrides?.getDataDir?.() ?? '/tmp/test-time-extension-data';
  return {
    getHistory: vi.fn(() => []),
    insertMessageAfter: vi.fn(() => true),
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    config: {} as ExtensionDeps['config'],
    modelResolver: {} as ExtensionDeps['modelResolver'],
    generateText: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ExtensionDeps['logger'],
    logging: {
      child: () => ({ info: vi.fn() }) as unknown as ExtensionDeps['logger'],
    } as unknown as ExtensionDeps['logging'],
    mcp: {} as unknown as ExtensionDeps['mcp'],
    sessionId: 'test-session',
    ...overrides,
    getDataDir: vi.fn(() =>
      join(dataDirectory, 'extensions', 'io.stagewise', 'time'),
    ),
  } as ExtensionDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- tests ---

describe('createTimeExt', () => {
  it('returns a factory with correct identifier and displayName', () => {
    const factory = createTimeExt(DEFAULT_CONFIG);
    expect(factory.identifier).toBe('io.stagewise/time');
    expect(factory.displayName).toBe('Time');
  });

  it.each([NaN, Infinity, -Infinity, -1, 1.5])(
    'rejects invalid update period %s',
    (timeUpdatePeriod) => {
      expect(() => createTimeExt({ timeUpdatePeriod })).toThrow(
        'timeUpdatePeriod must be a non-negative integer',
      );
    },
  );
});

describe('TimeExt.onStart', () => {
  it('loads persisted timezone without injecting', async () => {
    const dir = makeTmpDir();
    writeLegacyTimezone(dir, JSON.stringify({ timezone: 'Asia/Tokyo' }));
    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);

    await ext.onStart?.();

    expect(ext.introspect?.()).toMatchObject({ timezone: 'Asia/Tokyo' });
    expect(deps.inbox.sendMessage).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('TimeExt.getProvisionalStepContext', () => {
  it('returns time and timezone when no time part exists', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const result = ext.getProvisionalStepContext?.(
      [makeUserMessage('hello')],
      {} as never,
    ) as ProvisionalStepContext;

    expect(result.parts.map((part) => part.type)).toEqual([
      'data-time',
      'data-timezone',
    ]);
  });

  it('returns both parts when timezone is missing but time is recent', () => {
    const recentTs = Math.floor(Date.now() / 1000) - 10;
    const ext = createTimeExt({ timeUpdatePeriod: 300 }).create(makeDeps());
    const result = ext.getProvisionalStepContext?.(
      [makeTimeMessage(recentTs)],
      {} as never,
    ) as ProvisionalStepContext;

    expect(result.parts.map((part) => part.type)).toEqual([
      'data-time',
      'data-timezone',
    ]);
  });

  it('returns only time when timezone exists and time is stale', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const ext = createTimeExt({ timeUpdatePeriod: 300 }).create(makeDeps());
    const result = ext.getProvisionalStepContext?.(
      [makeTimeAndTimezoneMessage(oldTs)],
      {} as never,
    ) as ProvisionalStepContext;

    expect(result.parts.map((part) => part.type)).toEqual(['data-time']);
  });

  it('returns no parts when time is recent and timezone exists', () => {
    const recentTs = Math.floor(Date.now() / 1000) - 10;
    const ext = createTimeExt({ timeUpdatePeriod: 300 }).create(makeDeps());
    const result = ext.getProvisionalStepContext?.(
      [makeTimeAndTimezoneMessage(recentTs)],
      {} as never,
    ) as ProvisionalStepContext;

    expect(result).toEqual({ parts: [] });
  });

  it('uses the latest time part when multiple exist', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const recentTs = Math.floor(Date.now() / 1000) - 10;
    const history = [
      makeTimeAndTimezoneMessage(oldTs),
      makeTextMessage('hello'),
      makeTimeAndTimezoneMessage(recentTs),
    ];
    const ext = createTimeExt({ timeUpdatePeriod: 300 }).create(makeDeps());
    const result = ext.getProvisionalStepContext?.(
      history,
      {} as never,
    ) as ProvisionalStepContext;

    expect(result).toEqual({ parts: [] });
  });

  it('refreshes at the exact update-period boundary', () => {
    const now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());

    const result = ext.getProvisionalStepContext?.(
      [makeTimeAndTimezoneMessage(now - DEFAULT_CONFIG.timeUpdatePeriod)],
      {} as never,
    ) as ProvisionalStepContext;

    expect(result.parts.map((part) => part.type)).toEqual(['data-time']);
    clock.mockRestore();
  });

  it('always refreshes when the update period is zero', () => {
    const now = Math.floor(Date.now() / 1000);
    const ext = createTimeExt({ timeUpdatePeriod: 0 }).create(makeDeps());
    const result = ext.getProvisionalStepContext?.(
      [makeTimeAndTimezoneMessage(now)],
      {} as never,
    ) as ProvisionalStepContext;

    expect(result.parts.map((part) => part.type)).toEqual(['data-time']);
  });

  it('ignores structurally malformed historical context', () => {
    const history = [
      {
        id: randomUUID(),
        role: 'user',
        parts: [
          { type: 'data-time', data: null },
          { type: 'data-timezone', data: { tz: 'UTC' } },
        ],
      } as unknown as ExtendedUIMessage,
    ];
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());

    expect(() =>
      ext.getProvisionalStepContext?.(history, {} as never),
    ).not.toThrow();
    const result = ext.getProvisionalStepContext?.(
      history,
      {} as never,
    ) as ProvisionalStepContext;
    expect(result.parts.map((part) => part.type)).toEqual([
      'data-time',
      'data-timezone',
    ]);
  });

  it('returns time and timezone when timezone has changed', async () => {
    const recentTs = Math.floor(Date.now() / 1000) - 10;
    const history = [makeTimeAndTimezoneMessage(recentTs, 'UTC')];
    const dir = makeTmpDir();
    writeLegacyTimezone(dir, JSON.stringify({ timezone: 'Europe/Berlin' }));
    const ext = createTimeExt(DEFAULT_CONFIG).create(
      makeDeps({ getDataDir: () => dir }),
    );
    await ext.onStart?.();
    const result = ext.getProvisionalStepContext?.(
      history,
      {} as never,
    ) as ProvisionalStepContext;

    expect(result.parts.map((part) => part.type)).toEqual([
      'data-time',
      'data-timezone',
    ]);
    const tzData = (result.parts[1] as { type: string; data: { tz: string } })
      .data;
    expect(tzData.tz).toBe('Europe/Berlin');

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns initial time and timezone for empty history', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const result = ext.getProvisionalStepContext?.(
      [],
      {} as never,
    ) as ProvisionalStepContext;

    expect(result.parts.map((part) => part.type)).toEqual([
      'data-time',
      'data-timezone',
    ]);
  });

  it('does not mutate history or use direct persistence dependencies', () => {
    const history = [makeUserMessage('hello')];
    const deps = makeDeps();
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    ext.getProvisionalStepContext?.(history, {} as never);

    expect(history).toHaveLength(1);
    expect(deps.insertMessageAfter).not.toHaveBeenCalled();
    expect(deps.inbox.sendMessage).not.toHaveBeenCalled();
  });

  it('refreshes a timestamp from the future after clock rollback', () => {
    const futureTs = Math.floor(Date.now() / 1000) + 60;
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const result = ext.getProvisionalStepContext?.(
      [makeTimeAndTimezoneMessage(futureTs)],
      {} as never,
    ) as ProvisionalStepContext;

    expect(result.parts.map((part) => part.type)).toEqual(['data-time']);
  });
});

describe('TimeExt.historyTransformer — compacted history', () => {
  async function runCompaction(
    original: ExtendedUIMessage[],
    deps: ExtensionDeps,
  ): Promise<ExtendedUIMessage[]> {
    const result = await createContextCompactionExt
      .create(deps)
      .historyTransformer?.(structuredClone(original), {} as never);
    if (!result) throw new Error('history transformer not registered');
    return Array.isArray(result) ? result : result.history;
  }

  it('carries the last time and timezone before the cutoff into the summary', async () => {
    const earlier = makeTimeAndTimezoneMessage(TS_SUN_1530, 'UTC');
    const latest = makeTimeAndTimezoneMessage(TS_SUN_1645, 'Europe/Berlin');
    const summary = makeSummaryMessage('Earlier history');
    const retained = makeTimeAndTimezoneMessage(TS_MON_0900, 'Asia/Tokyo');
    const original = [
      earlier,
      latest,
      summary,
      makeUserMessage('one'),
      makeTextMessage('answer'),
      makeUserMessage('two'),
      retained,
    ];
    const dir = makeTmpDir();
    const deps = makeDeps({
      getDataDir: () => dir,
      getHistory: vi.fn(() => original),
    });
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const tools = ext.getTools?.({} as never) ?? {};
    await tools.changeTimezone?.execute?.(
      { timezone: 'Asia/Tokyo' } as never,
      { toolCallId: 'test', messages: [] } as never,
    );
    const compacted = await runCompaction(original, deps);
    const result = ext.historyTransformer?.(compacted, {} as never);
    if (!result || !Array.isArray(result)) throw new Error('invalid result');

    expect(result[0]?.parts).toEqual([
      latest.parts[0],
      latest.parts[1],
      summary.parts[0],
    ]);
    expect(result.slice(1)).toEqual(compacted.slice(1));
    expect(result.at(-1)).toEqual(retained);
    expect(original[2]).toEqual(summary);

    const compactionExt = createContextCompactionExt.create(deps);
    const modelMessages = await convertToModelMessagesExtended(result, {
      ...compactionExt.dataPartTransformers,
      ...ext.dataPartTransformers,
    });
    expect(modelMessages[0]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<time>Sunday, 12.4.2026, 18:45</time>',
        },
        {
          type: 'text',
          text: '<timezone>Europe/Berlin, CEST, +02:00</timezone>',
        },
        { type: 'text', text: '<summary>Earlier history</summary>' },
      ],
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('omits synthetic time and uses the current timezone when none existed', async () => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const summary = makeSummaryMessage('Earlier history');
    const original = [
      makeTextMessage('before'),
      summary,
      makeUserMessage('one'),
      makeTextMessage('answer'),
      makeUserMessage('two'),
    ];
    const dir = makeTmpDir();
    const deps = makeDeps({
      getDataDir: () => dir,
      getHistory: vi.fn(() => original),
    });
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const tools = ext.getTools?.({} as never) ?? {};
    await tools.changeTimezone?.execute?.(
      { timezone: 'Asia/Tokyo' } as never,
      { toolCallId: 'test', messages: [] } as never,
    );
    const compacted = await runCompaction(original, deps);
    const result = ext.historyTransformer?.(compacted, {} as never);
    if (!result || !Array.isArray(result)) throw new Error('invalid result');

    expect(result[0]?.parts).toEqual([
      {
        type: 'data-timezone',
        data: { tz: 'Asia/Tokyo', timestamp: now },
      },
      summary.parts[0],
    ]);
    expect(
      result[0]?.parts.some((part) => (part.type as string) === 'data-time'),
    ).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    clock.mockRestore();
  });

  it('carries time independently and falls back for a missing timezone', async () => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const time = makeTimeMessage(TS_SUN_1530, 'Europe/Berlin');
    const summary = makeSummaryMessage('Earlier history');
    const original = [
      time,
      summary,
      makeUserMessage('one'),
      makeTextMessage('answer'),
      makeUserMessage('two'),
    ];
    const deps = makeDeps({ getHistory: vi.fn(() => original) });
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const compacted = await runCompaction(original, deps);
    const result = ext.historyTransformer?.(compacted, {} as never);
    if (!result || !Array.isArray(result)) throw new Error('invalid result');

    expect(result[0]?.parts.slice(0, 2)).toEqual([
      time.parts[0],
      {
        type: 'data-timezone',
        data: { tz: 'UTC', timestamp: now },
      },
    ]);
    clock.mockRestore();
  });

  it('carries timezone independently without inventing a missing time', async () => {
    const timezone = {
      id: randomUUID(),
      role: 'user',
      parts: [
        createDataPart(TIMEZONE_KEY, {
          tz: 'Europe/Berlin',
          timestamp: TS_SUN_1530,
        }) as never,
      ],
    } as ExtendedUIMessage;
    const summary = makeSummaryMessage('Earlier history');
    const original = [
      timezone,
      summary,
      makeUserMessage('one'),
      makeTextMessage('answer'),
      makeUserMessage('two'),
    ];
    const deps = makeDeps({ getHistory: vi.fn(() => original) });
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const compacted = await runCompaction(original, deps);
    const result = ext.historyTransformer?.(compacted, {} as never);
    if (!result || !Array.isArray(result)) throw new Error('invalid result');

    expect(result[0]?.parts).toEqual([timezone.parts[0], summary.parts[0]]);
    expect(
      result[0]?.parts.some((part) => (part.type as string) === 'data-time'),
    ).toBe(false);
  });

  it('ignores malformed cutoff context and carries the latest valid parts', async () => {
    const valid = makeTimeAndTimezoneMessage(TS_SUN_1530, 'UTC');
    const malformed = {
      id: randomUUID(),
      role: 'user',
      parts: [
        { type: 'data-time', data: { timestamp: Number.NaN } },
        {
          type: 'data-timezone',
          data: { tz: 'Invalid/Zone', timestamp: TS_SUN_1645 },
        },
      ],
    } as unknown as ExtendedUIMessage;
    const summary = makeSummaryMessage('Earlier history');
    const original = [
      valid,
      malformed,
      summary,
      makeUserMessage('one'),
      makeTextMessage('answer'),
      makeUserMessage('two'),
    ];
    const deps = makeDeps({ getHistory: vi.fn(() => original) });
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const compacted = await runCompaction(original, deps);
    const result = ext.historyTransformer?.(compacted, {} as never);
    if (!result || !Array.isArray(result)) throw new Error('invalid result');

    expect(result[0]?.parts.slice(0, 2)).toEqual(valid.parts);
  });

  it('does nothing when history was not cut from the front', () => {
    const original = [makeUserMessage('one'), makeTextMessage('answer')];
    const deps = makeDeps({ getHistory: vi.fn(() => original) });
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);

    expect(ext.historyTransformer?.(original, {} as never)).toBe(original);
    expect(
      ext.historyTransformer?.([makeUserMessage('unknown')], {} as never),
    ).toEqual([expect.objectContaining({ role: 'user' })]);
  });
});

describe('TimeExt.getTools — getTime', () => {
  it('returns formatted time in persisted timezone (UTC) without injecting', async () => {
    const deps = makeDeps();
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const tools = ext.getTools?.({} as never) ?? {};
    expect(tools.getTime).toBeDefined();

    const result = await tools.getTime?.execute?.(
      {} as never,
      { toolCallId: 'test', messages: [] } as never,
    );
    expect(typeof result?.time).toBe('string');
    expect(result?.time).toMatch(/\+00:00$/);
    expect(deps.inbox.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('treats timezone=%s as no override', async (_label, timezone) => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const tools = ext.getTools?.({} as never) ?? {};
    const schema = tools.getTime?.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };

    expect(schema.safeParse({ timezone }).success).toBe(true);
    const result = await tools.getTime?.execute?.(
      { timezone } as never,
      { toolCallId: 'test', messages: [] } as never,
    );

    expect(result?.time).toMatch(/\+00:00$/);
  });

  it('returns time in specified timezone without changing persisted tz', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(TS_SUN_1530 * 1000);
    const dir = makeTmpDir();
    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const tools = ext.getTools?.({} as never) ?? {};

    const result = await tools.getTime?.execute?.(
      { timezone: 'Europe/Berlin' } as never,
      { toolCallId: 'test', messages: [] } as never,
    );
    // Berlin in April is CEST → +02:00
    expect(result?.time).toMatch(/\+02:00$/);
    // Persisted timezone should still be UTC
    expect(ext.introspect?.()).toMatchObject({ timezone: 'UTC' });
    expect(deps.inbox.sendMessage).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
    clock.mockRestore();
  });

  it('rejects invalid timezone with a compact error', async () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const tools = ext.getTools?.({} as never) ?? {};

    await expect(
      tools.getTime?.execute?.(
        { timezone: 'Fake/Zone' } as never,
        { toolCallId: 'test', messages: [] } as never,
      ),
    ).rejects.toThrow(/Invalid timezone "Fake\/Zone".*IANA/);
  });
});

describe('TimeExt.getTools — changeTimezone', () => {
  it('is registered as a tool', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const tools = ext.getTools?.({} as never) ?? {};
    expect(tools.changeTimezone).toBeDefined();
  });

  it('changes timezone and atomically preserves unknown stored fields', async () => {
    const dir = makeTmpDir();
    writeLegacyTimezone(
      dir,
      JSON.stringify({ timezone: 'UTC', futureField: { keep: true } }),
    );
    const deps = makeDeps({ getDataDir: () => dir });
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const tools = ext.getTools?.({} as never) ?? {};

    const result = await tools.changeTimezone?.execute?.(
      { timezone: 'Europe/Berlin' } as never,
      { toolCallId: 'test', messages: [] } as never,
    );

    expect(result).toEqual({ timezone: 'Europe/Berlin' });
    expect(deps.inbox.sendMessage).not.toHaveBeenCalled();
    expect(deps.insertMessageAfter).not.toHaveBeenCalled();

    // Verify persistence
    const persisted = JSON.parse(readFileSync(timezonePath(dir), 'utf-8'));
    expect(persisted.timezone).toBe('Europe/Berlin');
    expect(persisted.futureField).toEqual({ keep: true });
    expect(persisted._klex).toMatchObject({
      store: 'time-extension-timezone',
      schemaVersion: 1,
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects invalid timezone with a compact error', async () => {
    const deps = makeDeps();
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const tools = ext.getTools?.({} as never) ?? {};

    await expect(
      tools.changeTimezone?.execute?.(
        { timezone: 'Not/A/Real_Zone' } as never,
        { toolCallId: 'test', messages: [] } as never,
      ),
    ).rejects.toThrow(/Invalid timezone "Not\/A\/Real_Zone".*IANA/);
    expect(deps.inbox.sendMessage).not.toHaveBeenCalled();
  });

  it('does not change in-memory state when persistence fails', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'extensions'), 'not a directory');
    const ext = createTimeExt(DEFAULT_CONFIG).create(
      makeDeps({ getDataDir: () => dir }),
    );
    const tools = ext.getTools?.({} as never) ?? {};

    await expect(
      tools.changeTimezone?.execute?.(
        { timezone: 'Europe/Berlin' } as never,
        { toolCallId: 'test', messages: [] } as never,
      ),
    ).rejects.toThrow();
    expect(ext.introspect?.()).toMatchObject({ timezone: 'UTC' });

    rmSync(dir, { recursive: true, force: true });
  });

  it('loaded timezone persists across extension instances', async () => {
    const dir = makeTmpDir();
    const deps1 = makeDeps({ getDataDir: () => dir });
    const ext1 = createTimeExt(DEFAULT_CONFIG).create(deps1);
    const tools1 = ext1.getTools?.({} as never) ?? {};
    await tools1.changeTimezone?.execute?.(
      { timezone: 'America/New_York' } as never,
      { toolCallId: 'test', messages: [] } as never,
    );

    // Create a new extension pointing at the same data dir
    const deps2 = makeDeps({ getDataDir: () => dir });
    const ext2 = createTimeExt(DEFAULT_CONFIG).create(deps2);
    await ext2.onStart?.();
    expect(ext2.introspect?.()).toMatchObject({
      timezone: 'America/New_York',
    });

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('TimeExt.getSystemPromptPart', () => {
  it('returns the system prompt markdown', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    expect(ext.getSystemPromptPart?.()).toBe('Time system prompt');
  });
});

describe('TimeExt.dataPartTransformers — time (UTC)', () => {
  it('renders legacy parts without timezone in UTC', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const transformer = getTransformer(ext, TIME_KEY);
    expect(transformer({ timestamp: TS_SUN_1530 }, 0)).toEqual([
      { type: 'text', text: '<time>Sunday, 12.4.2026, 15:30</time>' },
    ]);
  });

  it.each([null, {}, { timestamp: Number.NaN, tz: 'UTC' }])(
    'drops malformed timestamp data %# instead of breaking conversion',
    (data) => {
      const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
      const transformer = getTransformer(ext, TIME_KEY);
      expect(transformer(data, 0)).toEqual([]);
    },
  );

  it('renders full format for the first occurrence (occurrence 0)', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const transformer = getTransformer(ext, TIME_KEY);
    const result = transformer({ timestamp: TS_SUN_1530, tz: 'UTC' }, 0);
    expect(result).toEqual([
      { type: 'text', text: '<time>Sunday, 12.4.2026, 15:30</time>' },
    ]);
  });

  it('renders short format for subsequent occurrence on the same day', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const transformer = getTransformer(ext, TIME_KEY);

    transformer({ timestamp: TS_SUN_1530, tz: 'UTC' }, 0);
    const result = transformer({ timestamp: TS_SUN_1645, tz: 'UTC' }, 1);
    expect(result).toEqual([{ type: 'text', text: '<time>16:45</time>' }]);
  });

  it('renders full format when the calendar day changes', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const transformer = getTransformer(ext, TIME_KEY);

    transformer({ timestamp: TS_SUN_1530, tz: 'UTC' }, 0);
    const result = transformer({ timestamp: TS_MON_0900, tz: 'UTC' }, 1);
    expect(result).toEqual([
      { type: 'text', text: '<time>Monday, 13.4.2026, 9:00</time>' },
    ]);
  });

  it('renders full format on occurrence 0 even if day matches previous pass', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const transformer = getTransformer(ext, TIME_KEY);

    transformer({ timestamp: TS_SUN_1530, tz: 'UTC' }, 0);
    transformer({ timestamp: TS_SUN_1645, tz: 'UTC' }, 1);

    // New pass — occurrence 0, same day — should still be full
    const result = transformer({ timestamp: TS_SUN_1645, tz: 'UTC' }, 0);
    expect(result[0]).toEqual({
      type: 'text',
      text: '<time>Sunday, 12.4.2026, 16:45</time>',
    });
  });
});

describe('TimeExt.dataPartTransformers — time (Europe/Berlin)', () => {
  // April 12, 2026 is during CEST (UTC+2)
  it('renders in the stored timezone, not the current extension timezone', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const transformer = getTransformer(ext, TIME_KEY);
    // 15:30 UTC → 17:30 CEST
    const result = transformer(
      { timestamp: TS_SUN_1530, tz: 'Europe/Berlin' },
      0,
    );
    expect(result).toEqual([
      { type: 'text', text: '<time>Sunday, 12.4.2026, 17:30</time>' },
    ]);
  });

  it('short format also uses the stored timezone', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const transformer = getTransformer(ext, TIME_KEY);
    transformer({ timestamp: TS_SUN_1530, tz: 'Europe/Berlin' }, 0);
    // 16:45 UTC → 18:45 CEST
    const result = transformer(
      { timestamp: TS_SUN_1645, tz: 'Europe/Berlin' },
      1,
    );
    expect(result).toEqual([{ type: 'text', text: '<time>18:45</time>' }]);
  });

  it('keeps historical model context stable after the active timezone changes', async () => {
    const dir = makeTmpDir();
    const ext = createTimeExt(DEFAULT_CONFIG).create(
      makeDeps({ getDataDir: () => dir }),
    );
    const timeTransformer = getTransformer(ext, TIME_KEY);
    const timezoneTransformer = getTransformer(ext, TIMEZONE_KEY);
    const historicalTime = { timestamp: TS_SUN_1530, tz: 'Europe/Berlin' };
    const historicalTimezone = {
      tz: 'Europe/Berlin',
      timestamp: TS_SUN_1530,
    };
    const before = {
      time: timeTransformer(historicalTime, 0),
      timezone: timezoneTransformer(historicalTimezone, 0),
    };

    const tools = ext.getTools?.({} as never) ?? {};
    await tools.changeTimezone?.execute?.(
      { timezone: 'Asia/Tokyo' } as never,
      { toolCallId: 'test', messages: [] } as never,
    );

    expect({
      time: timeTransformer(historicalTime, 0),
      timezone: timezoneTransformer(historicalTimezone, 0),
    }).toEqual(before);
    expect(ext.introspect?.()).toMatchObject({ timezone: 'Asia/Tokyo' });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('TimeExt.dataPartTransformers — timezone', () => {
  it('always renders VV, z, XXX format (UTC)', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const transformer = getTransformer(ext, TIMEZONE_KEY);
    const result = transformer({ tz: 'UTC', timestamp: TS_SUN_1530 }, 0);
    expect(result).toEqual([
      { type: 'text', text: '<timezone>UTC, UTC, +00:00</timezone>' },
    ]);
  });

  it('renders VV, z, XXX for Europe/Berlin', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const transformer = getTransformer(ext, TIMEZONE_KEY);
    const result = transformer(
      { tz: 'Europe/Berlin', timestamp: TS_SUN_1530 },
      0,
    );
    expect(result).toEqual([
      {
        type: 'text',
        text: '<timezone>Europe/Berlin, CEST, +02:00</timezone>',
      },
    ]);
  });
});

describe('TimeExt.introspect', () => {
  it('returns configuration and default timezone', () => {
    const ext = createTimeExt({ timeUpdatePeriod: 300 }).create(makeDeps());
    expect(ext.introspect?.()).toEqual({
      timeUpdatePeriod: 300,
      timezone: 'UTC',
    });
  });

  it('does not keep mutable timestamp state after producing context', () => {
    const history = [makeUserMessage('hello')];
    const deps = makeDeps({ getHistory: vi.fn(() => history) });
    const ext = createTimeExt({ timeUpdatePeriod: 300 }).create(deps);
    const result = ext.getProvisionalStepContext?.(
      history,
      {} as never,
    ) as ProvisionalStepContext;
    expect(result.parts.length).toBeGreaterThan(0);
    const state = ext.introspect?.() as {
      timeUpdatePeriod: number;
      timezone: string;
    };
    expect(state.timeUpdatePeriod).toBe(300);
    expect(state.timezone).toBe('UTC');
  });
});

describe('TimeExt — timezone persistence', () => {
  it('defaults to UTC when no timezone file exists', () => {
    const dir = makeTmpDir();
    const ext = createTimeExt(DEFAULT_CONFIG).create(
      makeDeps({ getDataDir: () => dir }),
    );
    expect(ext.introspect?.()).toMatchObject({ timezone: 'UTC' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads an unversioned legacy timezone file on start', async () => {
    const dir = makeTmpDir();
    writeLegacyTimezone(dir, JSON.stringify({ timezone: 'Asia/Tokyo' }));
    const ext = createTimeExt(DEFAULT_CONFIG).create(
      makeDeps({ getDataDir: () => dir }),
    );
    await ext.onStart?.();
    expect(ext.introspect?.()).toMatchObject({ timezone: 'Asia/Tokyo' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects corrupted persisted timezone data', async () => {
    const dir = makeTmpDir();
    writeLegacyTimezone(dir, '{ broken json');
    const ext = createTimeExt(DEFAULT_CONFIG).create(
      makeDeps({ getDataDir: () => dir }),
    );
    await expect(ext.onStart?.()).rejects.toThrow('not valid JSON');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a persisted invalid timezone', async () => {
    const dir = makeTmpDir();
    writeLegacyTimezone(dir, JSON.stringify({ timezone: 'Invalid/Zone' }));
    const ext = createTimeExt(DEFAULT_CONFIG).create(
      makeDeps({ getDataDir: () => dir }),
    );
    await expect(ext.onStart?.()).rejects.toThrow(
      'not a valid IANA identifier',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CHECKPOINT_DATA_PART_TRANSFORMERS } from '../../checkpoint';
import type { ExtendedUIMessage } from '../../message-types';
import { convertToModelMessagesExtended } from '../../utils/convert-to-model-messages';
import {
  createDataPart,
  type ExtensionDeps,
  type ProvisionalStepContext,
} from '../extension-api';
import { createTimeExt, createTimeExtGod, type TimeExtConfig } from './time';

vi.mock('./system-prompt.md', () => ({
  default: 'time prompt',
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

const DEFAULT_CONFIG: TimeExtConfig = {
  timeUpdatePeriod: 300,
  timezone: 'UTC',
};

// --- helpers ---

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
    checkpoints: { commit: vi.fn(() => ({ status: 'pending' as const })) },
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
    getDataDir: vi.fn(() => dataDirectory),
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
      expect(() =>
        createTimeExt({ timeUpdatePeriod, timezone: 'UTC' }),
      ).toThrow('timeUpdatePeriod must be a non-negative integer');
    },
  );

  it('rejects an invalid configured timezone', () => {
    expect(() =>
      createTimeExt({ timeUpdatePeriod: 300, timezone: 'Fake/Zone' }),
    ).toThrow('timezone must be a valid IANA identifier');
  });

  it('captures one timezone for every instance created by the factory', () => {
    const config = { timeUpdatePeriod: 300, timezone: 'Europe/Berlin' };
    const factory = createTimeExt(config);
    config.timezone = 'Asia/Tokyo';

    expect(factory.create(makeDeps()).introspect?.()).toMatchObject({
      timezone: 'Europe/Berlin',
    });
  });
});

describe('TimeExt god tools', () => {
  it('does not expose timezone updates in standard sessions', () => {
    const tools = createTimeExt(DEFAULT_CONFIG)
      .create(makeDeps())
      .getTools?.({} as never);

    expect(tools).not.toHaveProperty('updateTimezone');
  });

  it('persists a valid timezone for the next process start', async () => {
    let persisted: Record<string, unknown> = {
      timezone: 'UTC',
      preserved: true,
    };
    const mutate = vi.fn(
      async (
        update: (current: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        persisted = update(persisted);
        return persisted;
      },
    );
    const ext = createTimeExtGod(DEFAULT_CONFIG).create(
      makeDeps({ config: { mutate } as unknown as ExtensionDeps['config'] }),
    );
    const tools = ext.getTools?.({} as never) ?? {};

    const result = await tools.updateTimezone?.execute?.(
      { timezone: 'Europe/Berlin' } as never,
      { toolCallId: 'test', messages: [] } as never,
    );

    expect(mutate).toHaveBeenCalledOnce();
    expect(persisted).toEqual({
      timezone: 'Europe/Berlin',
      preserved: true,
    });
    expect(result).toBe(
      'Timezone updated, will be active after restart of the agent.',
    );
    expect(ext.introspect?.()).toMatchObject({
      mode: 'god',
      timezone: 'UTC',
    });
  });

  it('rejects invalid timezone updates in the tool schema', () => {
    const tools = createTimeExtGod(DEFAULT_CONFIG)
      .create(makeDeps())
      .getTools?.({} as never);
    const schema = tools?.updateTimezone?.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };

    expect(schema.safeParse({ timezone: 'Fake/Zone' }).success).toBe(false);
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
    const ext = createTimeExt({
      timeUpdatePeriod: 300,
      timezone: 'UTC',
    }).create(makeDeps());
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
    const ext = createTimeExt({
      timeUpdatePeriod: 300,
      timezone: 'UTC',
    }).create(makeDeps());
    const result = ext.getProvisionalStepContext?.(
      [makeTimeAndTimezoneMessage(oldTs)],
      {} as never,
    ) as ProvisionalStepContext;

    expect(result.parts.map((part) => part.type)).toEqual(['data-time']);
  });

  it('returns no parts when time is recent and timezone exists', () => {
    const recentTs = Math.floor(Date.now() / 1000) - 10;
    const ext = createTimeExt({
      timeUpdatePeriod: 300,
      timezone: 'UTC',
    }).create(makeDeps());
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
    const ext = createTimeExt({
      timeUpdatePeriod: 300,
      timezone: 'UTC',
    }).create(makeDeps());
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
    const ext = createTimeExt({ timeUpdatePeriod: 0, timezone: 'UTC' }).create(
      makeDeps(),
    );
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

  it('returns time and timezone when the startup timezone differs from history', () => {
    const recentTs = Math.floor(Date.now() / 1000) - 10;
    const history = [makeTimeAndTimezoneMessage(recentTs, 'UTC')];
    const ext = createTimeExt({
      timeUpdatePeriod: 300,
      timezone: 'Europe/Berlin',
    }).create(makeDeps());
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

describe('TimeExt.getCheckpointCarry', () => {
  /** Builds the header core would write: summary first, then carry parts. */
  function makeHeader(
    carry: ExtendedUIMessage['parts'],
    summary = 'Earlier history',
  ): ExtendedUIMessage {
    const header = makeSummaryMessage(summary);
    return { ...header, parts: [...header.parts, ...carry] };
  }

  it('no longer transforms history itself', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    expect(ext.historyTransformer).toBeUndefined();
  });

  it('carries the latest time and timezone from the dropped prefix', async () => {
    const earlier = makeTimeAndTimezoneMessage(TS_SUN_1530, 'UTC');
    const latest = makeTimeAndTimezoneMessage(TS_SUN_1645, 'Europe/Berlin');
    const dropped = [earlier, makeTextMessage('answer'), latest];
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());

    const carry = await ext.getCheckpointCarry?.(dropped);

    expect(carry).toEqual([latest.parts[0], latest.parts[1]]);
    // Returned parts are clones, not references into the dropped messages.
    expect(carry?.[0]).not.toBe(latest.parts[0]);

    const modelMessages = await convertToModelMessagesExtended(
      [makeHeader(carry ?? [])],
      { ...CHECKPOINT_DATA_PART_TRANSFORMERS, ...ext.dataPartTransformers },
    );
    expect(modelMessages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: '<summary>Earlier history</summary>' },
        { type: 'text', text: '<time>Sunday, 12.4.2026, 18:45</time>' },
        {
          type: 'text',
          text: '<timezone>Europe/Berlin, CEST, +02:00</timezone>',
        },
      ],
    });
  });

  it('carries state that only lives in a previous checkpoint header', async () => {
    const latest = makeTimeAndTimezoneMessage(TS_SUN_1645, 'Europe/Berlin');
    const previousHeader = makeHeader(latest.parts);
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());

    const carry = await ext.getCheckpointCarry?.([
      previousHeader,
      makeUserMessage('one'),
      makeTextMessage('answer'),
    ]);

    expect(carry).toEqual(latest.parts);
  });

  it('omits synthetic time and uses the startup timezone when none existed', async () => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const ext = createTimeExt({
      timeUpdatePeriod: 300,
      timezone: 'Asia/Tokyo',
    }).create(makeDeps());

    const carry = await ext.getCheckpointCarry?.([makeTextMessage('before')]);

    expect(carry).toEqual([
      { type: 'data-timezone', data: { tz: 'Asia/Tokyo', timestamp: now } },
    ]);
    clock.mockRestore();
  });

  it('carries time independently and falls back for a missing timezone', async () => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const time = makeTimeMessage(TS_SUN_1530, 'Europe/Berlin');
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());

    const carry = await ext.getCheckpointCarry?.([time]);

    expect(carry).toEqual([
      time.parts[0],
      { type: 'data-timezone', data: { tz: 'UTC', timestamp: now } },
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
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());

    const carry = await ext.getCheckpointCarry?.([timezone]);

    expect(carry).toEqual([timezone.parts[0]]);
  });

  it('ignores malformed context and carries the latest valid parts', async () => {
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
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());

    const carry = await ext.getCheckpointCarry?.([valid, malformed]);

    expect(carry).toEqual(valid.parts);
  });

  it('carried parts suppress redundant provisional re-emission', async () => {
    const now = TS_MON_0900;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    const recent = makeTimeAndTimezoneMessage(now - 10, 'UTC');
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());

    const carry = (await ext.getCheckpointCarry?.([recent])) ?? [];
    const window = [makeHeader(carry), makeUserMessage('next')];
    const result = ext.getProvisionalStepContext?.(
      window,
      {} as never,
    ) as ProvisionalStepContext;

    expect(result).toEqual({ parts: [] });
    clock.mockRestore();
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

  it('returns time in a specified timezone without changing the startup timezone', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(TS_SUN_1530 * 1000);
    const deps = makeDeps();
    const ext = createTimeExt(DEFAULT_CONFIG).create(deps);
    const tools = ext.getTools?.({} as never) ?? {};

    const result = await tools.getTime?.execute?.(
      { timezone: 'Europe/Berlin' } as never,
      { toolCallId: 'test', messages: [] } as never,
    );
    // Berlin in April is CEST → +02:00
    expect(result?.time).toMatch(/\+02:00$/);
    // The process-wide startup timezone remains unchanged.
    expect(ext.introspect?.()).toMatchObject({ timezone: 'UTC' });
    expect(deps.inbox.sendMessage).not.toHaveBeenCalled();
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

  it('renders historical context using its recorded timezone', () => {
    const ext = createTimeExt(DEFAULT_CONFIG).create(makeDeps());
    const timeTransformer = getTransformer(ext, TIME_KEY);
    const timezoneTransformer = getTransformer(ext, TIMEZONE_KEY);

    expect({
      time: timeTransformer({ timestamp: TS_SUN_1530, tz: 'Europe/Berlin' }, 0),
      timezone: timezoneTransformer(
        { tz: 'Europe/Berlin', timestamp: TS_SUN_1530 },
        0,
      ),
    }).toEqual({
      time: [{ type: 'text', text: '<time>Sunday, 12.4.2026, 17:30</time>' }],
      timezone: [
        {
          type: 'text',
          text: '<timezone>Europe/Berlin, CEST, +02:00</timezone>',
        },
      ],
    });
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
    const ext = createTimeExt({
      timeUpdatePeriod: 300,
      timezone: 'UTC',
    }).create(makeDeps());
    expect(ext.introspect?.()).toEqual({
      mode: 'standard',
      timeUpdatePeriod: 300,
      timezone: 'UTC',
    });
  });

  it('does not keep mutable timestamp state after producing context', () => {
    const history = [makeUserMessage('hello')];
    const deps = makeDeps({ getHistory: vi.fn(() => history) });
    const ext = createTimeExt({
      timeUpdatePeriod: 300,
      timezone: 'UTC',
    }).create(deps);
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

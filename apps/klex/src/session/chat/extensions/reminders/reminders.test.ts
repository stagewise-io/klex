import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { type SessionInboxEvent, SessionInboxUrgency } from '@/session/inbox';

import type { ExtensionDeps, ExtensionFactory } from '../extension-api';
import { createRemindersExt } from './reminders';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function createMockDeps(): {
  deps: ExtensionDeps;
  sendInput: ReturnType<typeof vi.fn>;
} {
  const sendInput = vi
    .fn<(event: SessionInboxEvent) => Promise<void>>()
    .mockResolvedValue(undefined);
  const deps = {
    getHistory: () => [],
    insertMessageAfter: vi.fn(() => true),
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    config: { get: () => ({}) } as unknown as ExtensionDeps['config'],
    generateText: vi.fn(() =>
      Promise.resolve({
        success: false as const,
        failureReason: 'no-models' as const,
      }),
    ),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ModuleLogger,
    logging: {
      child: () =>
        ({
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          trace: vi.fn(),
        }) as unknown as ModuleLogger,
    } as unknown as ExtensionDeps['logging'],
    mcp: {} as unknown as ExtensionDeps['mcp'],
    router: { sendInput } as unknown as ExtensionDeps['router'],
    sessionId: 'test-session-id',
    getDataDir: vi.fn(() => '/tmp/test-reminders'),
  } as unknown as ExtensionDeps;

  return { deps, sendInput };
}

function getTool(ext: ReturnType<ExtensionFactory['create']>, name: string) {
  const tools = ext.getTools?.({} as never);
  if (!tools) throw new Error('Extension has no getTools');
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

async function callTool(
  ext: ReturnType<ExtensionFactory['create']>,
  name: string,
  input: Record<string, unknown>,
) {
  const tool = getTool(ext, name);
  // AI SDK tools have an execute function: (input, options) => Promise<output>
  const execute = ('execute' in tool ? tool.execute : undefined) as unknown as (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  if (!execute) throw new Error(`Tool ${name} has no execute`);
  return execute(input);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Reminders extension', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes setReminder and clearReminder tools', () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const tools = ext.getTools?.({} as never);
    if (!tools) throw new Error('Extension has no getTools');
    expect(tools).toHaveProperty('setReminder');
    expect(tools).toHaveProperty('clearReminder');
  });

  it('setReminder returns a numeric handle >= 1', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const result = await callTool(ext, 'setReminder', {
      duration: 5,
      unit: 'seconds',
      topic: 'Check deployment status',
    });
    expect(result.handle).toBeTypeOf('number');
    expect(result.handle).toBeGreaterThanOrEqual(1);
    await ext.onClose?.();
  });

  it('clearReminder on an active reminder returns cancelled: true', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const { handle } = await callTool(ext, 'setReminder', {
      duration: 10,
      unit: 'minutes',
      topic: 'Reminder to check logs',
    });
    const result = await callTool(ext, 'clearReminder', { handle });
    expect(result.cancelled).toBe(true);
    await ext.onClose?.();
  });

  it('clearReminder on unknown handle returns cancelled: false', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const result = await callTool(ext, 'clearReminder', { handle: 9999 });
    expect(result.cancelled).toBe(false);
    await ext.onClose?.();
  });

  it('fires reminder and sends event through router after duration', async () => {
    const { deps, sendInput } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    await callTool(ext, 'setReminder', {
      duration: 5,
      unit: 'seconds',
      topic: 'Check if deploy succeeded — user asked for health check',
    });

    // Advance time to fire the reminder.
    vi.advanceTimersByTime(5000);

    expect(sendInput).toHaveBeenCalledTimes(1);
    const event = sendInput.mock.calls[0]?.[0] as SessionInboxEvent;
    expect(event.sourceEnv).toBe('reminders');
    expect(event.urgency).toBe(SessionInboxUrgency.Default);
    expect(event.context.metadata).toMatchObject({
      type: 'reminder.fired',
      handle: expect.any(Number),
      topic: 'Check if deploy succeeded — user asked for health check',
      originSessionId: 'test-session-id',
      setAt: expect.any(String),
      firedAt: expect.any(String),
    });
    expect(event.context.content).toEqual([
      {
        type: 'text',
        text: 'Reminder fired: Check if deploy succeeded — user asked for health check',
      },
    ]);
    await ext.onClose?.();
  });

  it('fires reminder through router even after onClose (survival guarantee)', async () => {
    const { deps, sendInput } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    await callTool(ext, 'setReminder', {
      duration: 5,
      unit: 'seconds',
      topic: 'Should fire after close',
    });
    await ext.onClose?.();

    vi.advanceTimersByTime(5000);

    // Reminder fires after close — event goes through the router, not dropped.
    expect(sendInput).toHaveBeenCalledTimes(1);
    const event = sendInput.mock.calls[0]?.[0] as SessionInboxEvent;
    expect(event.context.metadata).toMatchObject({
      topic: 'Should fire after close',
    });
  });

  it('clearReminder prevents the reminder from firing', async () => {
    const { deps, sendInput } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const { handle } = await callTool(ext, 'setReminder', {
      duration: 5,
      unit: 'seconds',
      topic: 'Should be cancelled',
    });
    await callTool(ext, 'clearReminder', { handle });

    vi.advanceTimersByTime(5000);

    expect(sendInput).not.toHaveBeenCalled();
    await ext.onClose?.();
  });

  it('clearReminder on an already-fired reminder returns cancelled: false', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const { handle } = await callTool(ext, 'setReminder', {
      duration: 1,
      unit: 'seconds',
      topic: 'Fires immediately',
    });

    vi.advanceTimersByTime(1000);

    const result = await callTool(ext, 'clearReminder', { handle });
    expect(result.cancelled).toBe(false);
    await ext.onClose?.();
  });

  it('handles multiple concurrent reminders with unique handles', async () => {
    const { deps, sendInput } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const r1 = await callTool(ext, 'setReminder', {
      duration: 5,
      unit: 'seconds',
      topic: 'Reminder A',
    });
    const r2 = await callTool(ext, 'setReminder', {
      duration: 10,
      unit: 'seconds',
      topic: 'Reminder B',
    });

    expect(r1.handle).not.toBe(r2.handle);

    vi.advanceTimersByTime(5000);
    expect(sendInput).toHaveBeenCalledTimes(1);
    const eventA = sendInput.mock.calls[0]?.[0] as SessionInboxEvent;
    expect(eventA.context.metadata).toMatchObject({ topic: 'Reminder A' });

    vi.advanceTimersByTime(5000);
    expect(sendInput).toHaveBeenCalledTimes(2);
    const eventB = sendInput.mock.calls[1]?.[0] as SessionInboxEvent;
    expect(eventB.context.metadata).toMatchObject({ topic: 'Reminder B' });

    await ext.onClose?.();
  });

  it('rejects duration < 1 via zod schema validation', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const tool = getTool(ext, 'setReminder');
    // zod schema parsing happens before execute — verify the schema rejects.
    const schema = tool.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };
    const result = schema.safeParse({
      duration: 0,
      unit: 'seconds',
      topic: 'test',
    });
    expect(result.success).toBe(false);
    await ext.onClose?.();
  });

  it('rejects empty topic via zod schema validation', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const tool = getTool(ext, 'setReminder');
    const schema = tool.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };
    const result = schema.safeParse({
      duration: 5,
      unit: 'seconds',
      topic: '',
    });
    expect(result.success).toBe(false);
    await ext.onClose?.();
  });

  it('rejects topic > 200 chars via zod schema validation', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const tool = getTool(ext, 'setReminder');
    const schema = tool.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };
    const result = schema.safeParse({
      duration: 5,
      unit: 'seconds',
      topic: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
    await ext.onClose?.();
  });

  it('rejects duration exceeding 7 days via non-days unit', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    // 8 days in hours = 192 hours
    await expect(
      callTool(ext, 'setReminder', {
        duration: 192,
        unit: 'hours',
        topic: 'Should be rejected',
      }),
    ).rejects.toThrow(/maximum of 7 days/);
    await ext.onClose?.();
  });

  it('accepts duration at exactly 7 days', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const result = await callTool(ext, 'setReminder', {
      duration: 7,
      unit: 'days',
      topic: 'Exactly 7 days — should succeed',
    });
    expect(result.handle).toBeTypeOf('number');
    await ext.onClose?.();
  });

  it('rejects 7 days + 1 second', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    // 7 days in seconds = 604800; +1 = 604801 which is 7 days + 1s
    await expect(
      callTool(ext, 'setReminder', {
        duration: 604_801,
        unit: 'seconds',
        topic: 'Should be rejected',
      }),
    ).rejects.toThrow(/maximum of 7 days/);
    await ext.onClose?.();
  });

  it('rejects setReminder after onClose', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    await ext.onClose?.();
    await expect(
      callTool(ext, 'setReminder', {
        duration: 5,
        unit: 'seconds',
        topic: 'Should be rejected',
      }),
    ).rejects.toThrow(/closed/);
  });

  it('rejects clearReminder after onClose', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    await ext.onClose?.();
    await expect(callTool(ext, 'clearReminder', { handle: 1 })).rejects.toThrow(
      /closed/,
    );
  });

  it('rejects setting more than 10 concurrent reminders', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    // Set 10 reminders (the maximum).
    for (let i = 0; i < 10; i++) {
      await callTool(ext, 'setReminder', {
        duration: 60,
        unit: 'seconds',
        topic: `Reminder ${i}`,
      });
    }
    // The 11th should fail.
    await expect(
      callTool(ext, 'setReminder', {
        duration: 60,
        unit: 'seconds',
        topic: 'Should be rejected',
      }),
    ).rejects.toThrow(/maximum of 10 concurrent/i);
    await ext.onClose?.();
  });

  it('allows setting a new reminder after clearing one at the limit', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    for (let i = 0; i < 10; i++) {
      await callTool(ext, 'setReminder', {
        duration: 60,
        unit: 'seconds',
        topic: `Reminder ${i}`,
      });
    }
    // Clear one — the handle is 1 (first set).
    await callTool(ext, 'clearReminder', { handle: 1 });
    // Now we should be able to set a new one.
    const result = await callTool(ext, 'setReminder', {
      duration: 60,
      unit: 'seconds',
      topic: 'New reminder after clear',
    });
    expect(result.handle).toBeTypeOf('number');
    await ext.onClose?.();
  });

  it('introspect returns active reminder count, nextFireAt, and reminder entries', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    await callTool(ext, 'setReminder', {
      duration: 60,
      unit: 'seconds',
      topic: 'test',
    });
    const state = ext.introspect?.() as Record<string, unknown>;
    expect(state.activeReminders).toBe(1);
    expect(state.nextFireAt).toBeTypeOf('string');
    // nextFireAt should be an ISO string in the future.
    const fireDate = new Date(state.nextFireAt as string);
    expect(fireDate.getTime()).toBeGreaterThan(Date.now());
    // reminders array should contain the full entry with handle, topic, setAt, firesAt
    const reminders = state.reminders as Array<Record<string, unknown>>;
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first?.handle).toBeTypeOf('number');
    expect(first?.topic).toBe('test');
    expect(first?.setAt).toBeTypeOf('string');
    expect(first?.firesAt).toBeTypeOf('string');
    await ext.onClose?.();
  });

  it('introspect returns null nextFireAt when no reminders are active', () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const state = ext.introspect?.() as Record<string, unknown>;
    expect(state.activeReminders).toBe(0);
    expect(state.nextFireAt).toBeNull();
    expect(state.reminders).toEqual([]); // also verify empty array
  });

  it('introspect returns reminders sorted by soonest-firing first', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    await callTool(ext, 'setReminder', {
      duration: 5,
      unit: 'minutes',
      topic: 'fires later',
    });
    await callTool(ext, 'setReminder', {
      duration: 1,
      unit: 'minutes',
      topic: 'fires first',
    });
    const state = ext.introspect?.() as Record<string, unknown>;
    const reminders = state.reminders as Array<Record<string, unknown>>;
    expect(reminders).toHaveLength(2);
    expect(reminders[0]?.topic).toBe('fires first');
    expect(reminders[1]?.topic).toBe('fires later');
    await ext.onClose?.();
  });

  it('getSystemPromptPart returns non-empty instructions', async () => {
    const { deps } = createMockDeps();
    const ext = createRemindersExt.create(deps);
    const prompt = ext.getSystemPromptPart?.() ?? '';
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('topic');
    expect(prompt).toContain('7 days');
    expect(prompt).toContain('10');
    await ext.onClose?.();
  });
});

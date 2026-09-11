import { describe, expect, it, vi } from 'vitest';

import { SessionInboxUrgency } from '@/session/inbox';

import {
  type GenerationLaneHost,
  GenerationLaneLeaseManager,
  GenerationLaneUnavailableError,
} from './lease-manager';
import type { InteractionLeaseRequest } from './types';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  // biome-ignore lint/suspicious/noExplicitAny: test double for ModuleLogger
} as any;

function createHost(overrides: Partial<GenerationLaneHost> = {}) {
  const host: GenerationLaneHost = {
    sessionId: 'session-1',
    quiesceGenerationLane: vi.fn(async () => {}),
    resumeGenerationLane: vi.fn(),
    prepareContext: vi.fn(async () => ({
      context: {
        instructions: 'be nice',
        messages: [],
        tools: [],
        model: {
          modelId: 'openai:gpt-realtime',
          contextSize: 128_000,
          inputCapabilities: {},
        },
        historyRevision: 0,
        updateWatermark: 0,
      },
      commit: vi.fn(),
      rollback: vi.fn(),
    })),
    executeTool: vi.fn(async () => ({
      executionId: 'exec-1',
      status: 'success' as const,
      output: null,
    })),
    finalizeLease: vi.fn(),
    commit: vi.fn(async () => {}),
    ...overrides,
  };
  return host;
}

function createRequest(): InteractionLeaseRequest {
  return {
    mode: 'realtime',
    externalSessionId: 'media-1',
    namespace: 'discord',
    signal: new AbortController().signal,
    model: {
      modelId: 'openai:gpt-realtime',
      contextSize: 128_000,
      inputCapabilities: {},
    },
  };
}

const inboxEvent = {
  sourceEnv: 'discord',
  urgency: SessionInboxUrgency.Default,
  context: { sourceEnv: 'discord', metadata: {}, content: [] },
};

describe('GenerationLaneLeaseManager', () => {
  it('quiesces the chat lane before issuing a lease', async () => {
    const host = createHost();
    const manager = new GenerationLaneLeaseManager({ host, logger });

    const lease = await manager.acquire(createRequest());

    expect(host.quiesceGenerationLane).toHaveBeenCalledTimes(1);
    expect(lease.sessionId).toBe('session-1');
    expect(manager.isLeased()).toBe(true);
  });

  it('rejects a second lease while one is active', async () => {
    const manager = new GenerationLaneLeaseManager({
      host: createHost(),
      logger,
    });
    await manager.acquire(createRequest());

    await expect(manager.acquire(createRequest())).rejects.toBeInstanceOf(
      GenerationLaneUnavailableError,
    );
  });

  it('resumes the chat lane after release and frees the lane', async () => {
    const host = createHost();
    const manager = new GenerationLaneLeaseManager({ host, logger });
    const lease = await manager.acquire(createRequest());

    await lease.release('call-ended');

    expect(await lease.closed).toEqual({
      type: 'released',
      reason: 'call-ended',
    });
    expect(host.resumeGenerationLane).toHaveBeenCalledTimes(1);
    expect(manager.isLeased()).toBe(false);
  });

  it('forwards inbox events to the lease holder with monotonic sequences', async () => {
    const manager = new GenerationLaneLeaseManager({
      host: createHost(),
      logger,
    });
    const lease = await manager.acquire(createRequest());
    const iterator = lease.updates[Symbol.asyncIterator]();

    expect(manager.forward(inboxEvent, true)).toBe(true);
    expect(manager.forward(inboxEvent, false)).toBe(true);

    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.value?.sequence).toBe(1);
    expect(first.value?.requestResponse).toBe(true);
    expect(second.value?.sequence).toBe(2);
    expect(second.value?.requestResponse).toBe(false);
  });

  it('does not redeliver updates covered by the bootstrap watermark', async () => {
    let finishBootstrap!: () => void;
    const bootstrapReady = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    const host = createHost({
      prepareContext: vi.fn(async () => {
        await bootstrapReady;
        return {
          context: {
            instructions: 'be nice',
            messages: [],
            tools: [],
            model: {
              modelId: 'openai:gpt-realtime',
              contextSize: 128_000,
              inputCapabilities: {},
            },
            historyRevision: 1,
            updateWatermark: 1,
          },
          commit: vi.fn(),
          rollback: vi.fn(),
        };
      }),
    });
    const manager = new GenerationLaneLeaseManager({ host, logger });
    const lease = await manager.acquire(createRequest());

    expect(manager.forward(inboxEvent, false)).toBe(true);
    const bootstrapping = lease.bootstrap();
    expect(manager.forward(inboxEvent, false)).toBe(true);
    finishBootstrap();
    await bootstrapping;

    const next = lease.updates[Symbol.asyncIterator]().next();
    await expect(next).resolves.toMatchObject({
      done: false,
      value: { sequence: 2 },
    });
  });

  it('drops forwarded events when no lease is active', () => {
    const manager = new GenerationLaneLeaseManager({
      host: createHost(),
      logger,
    });
    expect(manager.forward(inboxEvent, true)).toBe(false);
  });

  it('revokes the active lease and keeps the lane closed', async () => {
    const host = createHost();
    const manager = new GenerationLaneLeaseManager({ host, logger });
    const lease = await manager.acquire(createRequest());

    manager.revoke('primary-session-closed');

    expect(await lease.closed).toEqual({
      type: 'revoked',
      reason: 'primary-session-closed',
    });
    expect(host.resumeGenerationLane).not.toHaveBeenCalled();
    await expect(manager.acquire(createRequest())).rejects.toThrow(
      /primary session is closed/,
    );
  });

  it('lets revocation win while release is draining admitted commits', async () => {
    let allowCommit!: () => void;
    let markStarted!: () => void;
    const commitAllowed = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const commitStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const host = createHost({
      commit: vi.fn(async () => {
        markStarted();
        await commitAllowed;
      }),
    });
    const manager = new GenerationLaneLeaseManager({ host, logger });
    const lease = await manager.acquire(createRequest());
    const admitted = lease.commit({
      type: 'user-transcript',
      eventId: 'evt-admitted',
      timestamp: '2026-01-01T00:00:00.000Z',
      text: 'before release',
    });
    await commitStarted;

    const releasing = lease.release('call-ended', {
      type: 'session-ended',
      eventId: 'evt-ended',
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    manager.revoke('primary-session-closed');
    allowCommit();
    await Promise.all([admitted, releasing]);

    expect(await lease.closed).toEqual({
      type: 'revoked',
      reason: 'primary-session-closed',
    });
    expect(host.commit).toHaveBeenCalledTimes(1);
    expect(host.resumeGenerationLane).not.toHaveBeenCalled();
  });

  it('drains admitted commits before the final event and drops later commits', async () => {
    const order: string[] = [];
    let allowCommit!: () => void;
    let markStarted!: () => void;
    const commitAllowed = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const commitStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const host = createHost({
      commit: vi.fn(async (event) => {
        order.push(event.type);
        if (event.type === 'user-transcript') {
          markStarted();
          await commitAllowed;
        }
      }),
    });
    const manager = new GenerationLaneLeaseManager({ host, logger });
    const lease = await manager.acquire(createRequest());
    const admitted = lease.commit({
      type: 'user-transcript',
      eventId: 'evt-admitted',
      timestamp: '2026-01-01T00:00:00.000Z',
      text: 'before release',
    });
    await commitStarted;

    const releasing = lease.release('call-ended', {
      type: 'session-ended',
      eventId: 'evt-ended',
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    await lease.commit({
      type: 'assistant-transcript',
      eventId: 'evt-late',
      timestamp: '2026-01-01T00:00:02.000Z',
      text: 'after release',
    });
    allowCommit();
    await Promise.all([admitted, releasing, lease.release('ignored')]);

    expect(order).toEqual(['user-transcript', 'session-ended']);
    expect(host.finalizeLease).toHaveBeenCalledTimes(1);
    expect(host.resumeGenerationLane).toHaveBeenCalledTimes(1);
  });

  it('does not commit the same event twice', async () => {
    const host = createHost();
    const manager = new GenerationLaneLeaseManager({ host, logger });
    const lease = await manager.acquire(createRequest());

    const event = {
      type: 'user-transcript' as const,
      eventId: 'evt-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      text: 'hello',
    };
    await lease.commit(event);
    await lease.commit(event);

    expect(host.commit).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import {
  type RuntimeResource,
  type RuntimeStartupModules,
  runtimeStartupOrder,
  startRuntime,
} from './runtime';

function createLoggingMock(): RootLogger {
  return {
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  } as unknown as RootLogger;
}

interface Recorded {
  readonly starts: string[];
  readonly closes: string[];
}

function createModules(options: {
  readonly recorded: Recorded;
  readonly withRealtime?: boolean;
  readonly failing?: string;
}): RuntimeStartupModules {
  const make = (name: string): RuntimeResource => ({
    start: async () => {
      if (options.failing === name) throw new Error(`${name} failed`);
      options.recorded.starts.push(name);
    },
    close: async () => {
      options.recorded.closes.push(name);
    },
  });
  return {
    modelCallLogger: make('model-call-logger'),
    sessionHistory: make('session-history'),
    skillRegistry: make('skill-registry'),
    adminApi: make('admin-api'),
    cloudConnectivity: make('cloud-connectivity'),
    sessionHost: make('session-host'),
    realtime: options.withRealtime === false ? undefined : make('realtime'),
    mcp: make('mcp'),
    telemetryManager: make('telemetry-manager'),
    godMessages: make('god-messages'),
  };
}

function emptyRecord(): Recorded {
  return { starts: [], closes: [] };
}

describe('runtime composition', () => {
  it('starts the session host before realtime and MCP', () => {
    const order = runtimeStartupOrder(
      createModules({ recorded: emptyRecord() }),
    ).map((step) => step.name);

    expect(order).toEqual([
      'model-call-logger',
      'session-history',
      'skill-registry',
      'admin-api',
      'cloud-connectivity',
      'session-host',
      'realtime',
      'mcp',
      'telemetry-manager',
      'god-messages',
    ]);
    expect(order.indexOf('session-host')).toBeLessThan(order.indexOf('mcp'));
    expect(order.indexOf('session-host')).toBeLessThan(
      order.indexOf('realtime'),
    );
  });

  it('omits realtime when no realtime provider is composed', () => {
    const order = runtimeStartupOrder(
      createModules({ recorded: emptyRecord(), withRealtime: false }),
    ).map((step) => step.name);

    expect(order).not.toContain('realtime');
    expect(order.indexOf('cloud-connectivity')).toBeLessThan(
      order.indexOf('session-host'),
    );
  });

  it('closes realtime before MCP and adopted resources last', async () => {
    const recorded = emptyRecord();
    const adopted = {
      close: async () => {
        recorded.closes.push('local-data');
      },
    };

    const runtime = await startRuntime({
      logging: createLoggingMock(),
      adopted: [adopted],
      modules: createModules({ recorded }),
    });
    await runtime.close();

    expect(recorded.closes).toEqual([
      'god-messages',
      'telemetry-manager',
      'realtime',
      'mcp',
      'session-host',
      'cloud-connectivity',
      'admin-api',
      'skill-registry',
      'model-call-logger',
      'session-history',
      'local-data',
    ]);
    // Sessions and the admin API stop writing skills before the registry flushes.
    expect(recorded.closes.indexOf('session-host')).toBeLessThan(
      recorded.closes.indexOf('skill-registry'),
    );
    // Sessions flush their final transcript before the store closes.
    expect(recorded.closes.indexOf('session-host')).toBeLessThan(
      recorded.closes.indexOf('session-history'),
    );
    // Event ingress and realtime sessions stop before the default session.
    expect(recorded.closes.indexOf('mcp')).toBeLessThan(
      recorded.closes.indexOf('session-host'),
    );
    expect(recorded.closes.indexOf('realtime')).toBeLessThan(
      recorded.closes.indexOf('session-host'),
    );
  });

  it('waits past the rollback deadline before closing transcript storage', async () => {
    vi.useFakeTimers();
    const sessionClosed = Promise.withResolvers<void>();
    try {
      const recorded = emptyRecord();
      const modules = createModules({ recorded });
      const closeSession = vi.fn(async () => {
        await sessionClosed.promise;
        recorded.closes.push('session-host');
      });
      modules.sessionHost.close = closeSession;
      const runtime = await startRuntime({
        logging: createLoggingMock(),
        modules,
      });
      const closing = runtime.close();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(closeSession).toHaveBeenCalledOnce();
      expect(recorded.closes).not.toContain('session-history');
      sessionClosed.resolve();
      await closing;
      expect(recorded.closes.indexOf('session-host')).toBeLessThan(
        recorded.closes.indexOf('session-history'),
      );
      expect(recorded.closes.at(-1)).toBe('session-history');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      sessionClosed.resolve();
      vi.useRealTimers();
    }
  });

  it('is idempotent across repeated close calls', async () => {
    const recorded = emptyRecord();
    const runtime = await startRuntime({
      logging: createLoggingMock(),
      modules: createModules({ recorded }),
    });

    await Promise.all([runtime.close(), runtime.close()]);
    await runtime.close();

    expect(recorded.closes).toHaveLength(10);
  });

  it('unwinds started modules and rethrows when one fails to start', async () => {
    const recorded = emptyRecord();
    const adoptedClose = vi.fn(async () => undefined);

    await expect(
      startRuntime({
        logging: createLoggingMock(),
        adopted: [{ close: adoptedClose }],
        modules: createModules({ recorded, failing: 'mcp' }),
      }),
    ).rejects.toThrow('mcp failed');

    expect(recorded.starts).toEqual([
      'model-call-logger',
      'session-history',
      'skill-registry',
      'admin-api',
      'cloud-connectivity',
      'session-host',
      'realtime',
    ]);
    expect(recorded.closes).toEqual([
      'mcp',
      'realtime',
      'session-host',
      'cloud-connectivity',
      'admin-api',
      'skill-registry',
      'session-history',
      'model-call-logger',
    ]);
    // Rollback of pre-runtime resources stays with their owner.
    expect(adoptedClose).not.toHaveBeenCalled();
  });

  it('bounds a hung rollback step and still releases earlier modules', async () => {
    vi.useFakeTimers();
    try {
      const recorded = emptyRecord();
      const modules = createModules({ recorded, failing: 'mcp' });
      modules.mcp.close = () => new Promise(() => {});
      const startup = expect(
        startRuntime({ logging: createLoggingMock(), modules }),
      ).rejects.toThrow('mcp failed');
      await vi.advanceTimersByTimeAsync(4_999);
      expect(recorded.closes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await startup;
      expect(recorded.closes).toEqual([
        'realtime',
        'session-host',
        'cloud-connectivity',
        'admin-api',
        'skill-registry',
        'session-history',
        'model-call-logger',
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues unwinding when a module close fails', async () => {
    const recorded = emptyRecord();
    const modules = createModules({ recorded });
    const failingClose: RuntimeResource = {
      start: async () => {
        recorded.starts.push('mcp');
      },
      close: async () => {
        throw new Error('mcp close failed');
      },
    };

    const runtime = await startRuntime({
      logging: createLoggingMock(),
      modules: { ...modules, mcp: failingClose },
    });
    await expect(runtime.close()).resolves.toBeUndefined();

    expect(recorded.closes).toEqual([
      'god-messages',
      'telemetry-manager',
      'realtime',
      'session-host',
      'cloud-connectivity',
      'admin-api',
      'skill-registry',
      'model-call-logger',
      'session-history',
    ]);
  });
});

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
    adminApi: make('admin-api'),
    cloudConnectivity: make('cloud-connectivity'),
    router: make('router'),
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
  it('starts the router before realtime and MCP', () => {
    const order = runtimeStartupOrder(
      createModules({ recorded: emptyRecord() }),
    ).map((step) => step.name);

    expect(order).toEqual([
      'model-call-logger',
      'admin-api',
      'cloud-connectivity',
      'router',
      'realtime',
      'mcp',
      'telemetry-manager',
      'god-messages',
    ]);
    expect(order.indexOf('router')).toBeLessThan(order.indexOf('mcp'));
    expect(order.indexOf('router')).toBeLessThan(order.indexOf('realtime'));
  });

  it('omits realtime when no realtime provider is composed', () => {
    const order = runtimeStartupOrder(
      createModules({ recorded: emptyRecord(), withRealtime: false }),
    ).map((step) => step.name);

    expect(order).not.toContain('realtime');
    expect(order.indexOf('cloud-connectivity')).toBeLessThan(
      order.indexOf('router'),
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
      'router',
      'cloud-connectivity',
      'admin-api',
      'model-call-logger',
      'local-data',
    ]);
    // Event ingress and realtime sessions stop before the primary session.
    expect(recorded.closes.indexOf('mcp')).toBeLessThan(
      recorded.closes.indexOf('router'),
    );
    expect(recorded.closes.indexOf('realtime')).toBeLessThan(
      recorded.closes.indexOf('router'),
    );
  });

  it('is idempotent across repeated close calls', async () => {
    const recorded = emptyRecord();
    const runtime = await startRuntime({
      logging: createLoggingMock(),
      modules: createModules({ recorded }),
    });

    await Promise.all([runtime.close(), runtime.close()]);
    await runtime.close();

    expect(recorded.closes).toHaveLength(8);
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
      'admin-api',
      'cloud-connectivity',
      'router',
      'realtime',
    ]);
    expect(recorded.closes).toEqual([
      'mcp',
      'realtime',
      'router',
      'cloud-connectivity',
      'admin-api',
      'model-call-logger',
    ]);
    // Rollback of pre-runtime resources stays with their owner.
    expect(adoptedClose).not.toHaveBeenCalled();
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
      'router',
      'cloud-connectivity',
      'admin-api',
      'model-call-logger',
    ]);
  });
});

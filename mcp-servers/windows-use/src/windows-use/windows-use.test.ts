import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';
import type {
  ProxyDaemon,
  ProxyDaemonOptions,
} from '@stagewise/mcp-proxy-sdk/daemon/node';

import type { WindowsUseConfig } from '@/config';
import type {
  WindowsMcpProcess,
  WindowsMcpProcessOptions,
} from '@/windows-mcp-process';

import { createWindowsUse } from './windows-use';

const config: WindowsUseConfig = {
  gatewayUrl: new URL('wss://gateway.example.com/environment'),
  gatewayToken: 'secret',
  windowsMcpCommand: 'uvx',
  windowsMcpLaunchMode: 'uvx',
  windowsMcpPort: 8123,
  logLevel: 'INFO',
};

function processFixture() {
  const value: WindowsMcpProcess = {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    running: false,
  };
  return value;
}

function daemonFixture() {
  const value: ProxyDaemon = {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    state: 'idle',
    activeExchangeCount: 0,
  };
  return value;
}

describe('WindowsUse', () => {
  it('starts in dependency order and closes in reverse order', async () => {
    const order: string[] = [];
    const child = processFixture();
    const daemon = daemonFixture();
    vi.mocked(child.start).mockImplementation(
      async () => void order.push('process:start'),
    );
    vi.mocked(child.close).mockImplementation(
      async () => void order.push('process:close'),
    );
    vi.mocked(daemon.start).mockImplementation(
      async () => void order.push('daemon:start'),
    );
    vi.mocked(daemon.close).mockImplementation(
      async () => void order.push('daemon:close'),
    );
    const app = createWindowsUse({
      config,
      logging: createLogger({ type: 'hidden' }),
      createProcess: () => child,
      createDaemon: () => daemon,
    });

    await app.start();
    await app.start();
    await app.close();
    await app.close();

    expect(order).toEqual([
      'process:start',
      'daemon:start',
      'daemon:close',
      'process:close',
    ]);
  });

  it('configures authenticated gateway connection and loopback handler', async () => {
    const child = processFixture();
    let processOptions: WindowsMcpProcessOptions | undefined;
    let daemonOptions: ProxyDaemonOptions | undefined;
    const app = createWindowsUse({
      config,
      logging: createLogger({ type: 'hidden' }),
      createProcess: (options) => {
        processOptions = options;
        return child;
      },
      createDaemon: (options) => {
        daemonOptions = options;
        return daemonFixture();
      },
    });

    await app.start();

    expect(processOptions).toEqual(
      expect.objectContaining({
        command: 'uvx',
        launchMode: 'uvx',
        port: 8123,
      }),
    );
    expect(daemonOptions?.connection()).toEqual({
      url: config.gatewayUrl,
      headers: { authorization: 'Bearer secret' },
    });
    const response = await daemonOptions?.handler.fetch(
      new Request('https://gateway/mcp'),
    );
    expect(response?.status).toBe(503);
    await app.close();
  });

  it('rolls back when daemon startup fails', async () => {
    const child = processFixture();
    const daemon = daemonFixture();
    vi.mocked(daemon.start).mockRejectedValue(new Error('gateway unavailable'));
    const app = createWindowsUse({
      config,
      logging: createLogger({ type: 'hidden' }),
      createProcess: () => child,
      createDaemon: () => daemon,
    });

    await expect(app.start()).rejects.toThrow('gateway unavailable');
    expect(daemon.close).toHaveBeenCalledOnce();
    expect(child.close).toHaveBeenCalledOnce();
  });

  it('surfaces unexpected child exits', () => {
    const onFatal = vi.fn();
    let processOptions: WindowsMcpProcessOptions | undefined;
    createWindowsUse({
      config,
      logging: createLogger({ type: 'hidden' }),
      onFatal,
      createProcess: (options) => {
        processOptions = options;
        return processFixture();
      },
      createDaemon: () => daemonFixture(),
    });

    processOptions?.onUnexpectedExit?.(new Error('child exited'));

    expect(onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'child exited' }),
    );
  });
});

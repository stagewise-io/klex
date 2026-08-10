import type { RootLogger } from '@stagewise/logger';
import {
  createProxyDaemon,
  type ProxyDaemon,
  type ProxyDaemonOptions,
} from '@stagewise/mcp-proxy-sdk/daemon/node';

import type { WindowsUseConfig } from '@/config';
import { createHttpUpstream } from '@/http-upstream';
import {
  createWindowsMcpProcess,
  type WindowsMcpProcess,
  type WindowsMcpProcessOptions,
} from '@/windows-mcp-process';

export interface WindowsUseOptions {
  readonly config: WindowsUseConfig;
  readonly logging: RootLogger;
  readonly onFatal?: (error: Error) => void;
  readonly createProcess?: (
    options: WindowsMcpProcessOptions,
  ) => WindowsMcpProcess;
  readonly createDaemon?: (options: ProxyDaemonOptions) => ProxyDaemon;
}

export interface WindowsUse {
  start(): Promise<void>;
  close(): Promise<void>;
}

class WindowsUseModule implements WindowsUse {
  readonly #process: WindowsMcpProcess;
  readonly #daemon: ProxyDaemon;
  #started = false;
  #closed = false;

  constructor(options: WindowsUseOptions) {
    const upstream = createHttpUpstream({
      url: `http://127.0.0.1:${options.config.windowsMcpPort}/mcp`,
    });
    const createProcess = options.createProcess ?? createWindowsMcpProcess;
    const createDaemon = options.createDaemon ?? createProxyDaemon;
    this.#process = createProcess({
      command: options.config.windowsMcpCommand,
      launchMode: options.config.windowsMcpLaunchMode,
      port: options.config.windowsMcpPort,
      logging: options.logging,
      onUnexpectedExit: (error) => options.onFatal?.(error),
    });
    this.#daemon = createDaemon({
      connection: () => ({
        url: options.config.gatewayUrl,
        headers: {
          authorization: `Bearer ${options.config.gatewayToken}`,
        },
      }),
      handler: upstream,
      reconnect: {},
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new Error('Windows-use application is closed');
    await this.#process.start();
    try {
      await this.#daemon.start();
      this.#started = true;
    } catch (error) {
      await this.#daemon.close().catch(() => undefined);
      await this.#process.close().catch(() => undefined);
      this.#closed = true;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    await this.#daemon.close();
    await this.#process.close();
  }
}

export function createWindowsUse(options: WindowsUseOptions): WindowsUse {
  return new WindowsUseModule(options);
}

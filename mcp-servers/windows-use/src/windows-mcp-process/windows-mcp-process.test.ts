import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createWindowsMcpProcess } from './windows-mcp-process';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill(signal?: NodeJS.Signals): boolean;
  };
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, null));
    return true;
  });
  return child;
}

describe('WindowsMcpProcess', () => {
  it('spawns fixed Windows-MCP arguments and waits for readiness', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child as never);
    const process = createWindowsMcpProcess({
      command: 'uvx',
      launchMode: 'uvx',
      port: 8123,
      logging: createLogger({ type: 'hidden' }),
      spawn,
      fetch: vi.fn(async () => new Response(null, { status: 405 })),
    });

    await process.start();
    await process.start();

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith('uvx', [
      'windows-mcp',
      'serve',
      '--transport',
      'streamable-http',
      '--stateless-http',
      '--host',
      '127.0.0.1',
      '--port',
      '8123',
    ]);
    expect(process.running).toBe(true);

    await process.close();
    await process.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('launches a packaged executable without the uvx package prefix', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child as never);
    const process = createWindowsMcpProcess({
      command: 'C:\\bundle\\windows-mcp.exe',
      launchMode: 'executable',
      port: 8123,
      logging: createLogger({ type: 'hidden' }),
      spawn,
      fetch: async () => new Response(),
    });

    await process.start();

    expect(spawn).toHaveBeenCalledWith('C:\\bundle\\windows-mcp.exe', [
      'serve',
      '--transport',
      'streamable-http',
      '--stateless-http',
      '--host',
      '127.0.0.1',
      '--port',
      '8123',
    ]);
    await process.close();
  });

  it('delegates shutdown to the process-tree terminator', async () => {
    const child = fakeChild();
    const terminateProcessTree = vi.fn(async () => undefined);
    const process = createWindowsMcpProcess({
      command: 'uvx',
      launchMode: 'uvx',
      port: 8123,
      logging: createLogger({ type: 'hidden' }),
      spawn: () => child as never,
      fetch: async () => new Response(),
      terminateProcessTree,
    });
    await process.start();

    await process.close();

    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledWith(child);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('rolls back when readiness fails', async () => {
    const child = fakeChild();
    const process = createWindowsMcpProcess({
      command: 'uvx',
      launchMode: 'uvx',
      port: 8123,
      logging: createLogger({ type: 'hidden' }),
      readinessTimeoutMs: 5,
      readinessIntervalMs: 1,
      spawn: () => child as never,
      fetch: async () => {
        throw new Error('refused');
      },
    });

    await expect(process.start()).rejects.toThrow(
      'Timed out waiting for Windows-MCP readiness',
    );
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('reports an unexpected exit after startup', async () => {
    const child = fakeChild();
    const onUnexpectedExit = vi.fn();
    const process = createWindowsMcpProcess({
      command: 'uvx',
      launchMode: 'uvx',
      port: 8123,
      logging: createLogger({ type: 'hidden' }),
      spawn: () => child as never,
      fetch: async () => new Response(),
      onUnexpectedExit,
    });
    await process.start();

    child.exitCode = 7;
    child.emit('exit', 7, null);

    expect(onUnexpectedExit).toHaveBeenCalledOnce();
    expect(onUnexpectedExit.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: expect.stringContaining('code=7') }),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import type {
  EnvironmentConnection,
  Unsubscribe,
} from '../connection/index.js';
import { createEnvironmentId } from '../identity/index.js';
import {
  createProxyExchangeId,
  type EnvironmentToProxyFrame,
  type ProxyToEnvironmentFrame,
} from '../protocol/index.js';
import { createProxy } from './proxy.js';

class TestConnection implements EnvironmentConnection {
  readonly sent: ProxyToEnvironmentFrame[] = [];
  readonly close = vi.fn(async () => undefined);
  failNextSend = false;
  #frameHandlers = new Set<(frame: EnvironmentToProxyFrame) => void>();
  #closeHandlers = new Set<(cause?: Error) => void>();
  async send(frame: ProxyToEnvironmentFrame): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('send failed');
    }
    this.sent.push(frame);
  }
  onFrame(handler: (frame: EnvironmentToProxyFrame) => void): Unsubscribe {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }
  onClose(handler: (cause?: Error) => void): Unsubscribe {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }
  emit(frame: EnvironmentToProxyFrame): void {
    for (const handler of this.#frameHandlers) handler(frame);
  }
  disconnect(cause?: Error): void {
    for (const handler of this.#closeHandlers) handler(cause);
  }
}

const environmentId = createEnvironmentId('environment-1');
const request = {
  method: 'POST',
  url: 'https://environment.invalid/mcp',
  headers: { accept: 'application/json' },
};

function setup(exchangeOpenTimeoutMs = 30_000) {
  let nextId = 0;
  const proxy = createProxy({
    createExchangeId: () => createProxyExchangeId(`exchange-${++nextId}`),
    exchangeOpenTimeoutMs,
  });
  const connection = new TestConnection();
  proxy.registerEnvironment(environmentId, connection);
  return { proxy, connection };
}

async function openExchange(
  proxy: ReturnType<typeof createProxy>,
  connection: TestConnection,
) {
  const opening = proxy.openExchange(environmentId, request);
  await vi.waitFor(() =>
    expect(connection.sent.at(-1)?.type).toBe('exchange.open'),
  );
  const frame = connection.sent.at(-1);
  if (frame?.type !== 'exchange.open')
    throw new Error('Expected exchange.open');
  connection.emit({
    version: 2,
    type: 'exchange.opened',
    exchangeId: frame.exchangeId,
    status: 200,
    statusText: 'OK',
    headers: {},
  });
  return opening;
}

describe('proxy', () => {
  it('opens and routes an exchange', async () => {
    const { proxy, connection } = setup();
    const exchange = await openExchange(proxy, connection);
    const chunk = vi.fn();
    const closed = vi.fn();
    exchange.onChunk(chunk);
    exchange.onClose(closed);
    connection.emit({
      version: 2,
      type: 'exchange.chunk',
      exchangeId: exchange.id,
      data: btoa('data'),
    });
    connection.emit({
      version: 2,
      type: 'exchange.close',
      exchangeId: exchange.id,
    });
    expect(await exchange.response).toMatchObject({ status: 200 });
    expect(chunk).toHaveBeenCalledWith(btoa('data'));
    expect(closed).toHaveBeenCalledWith(undefined);
  });

  it('replays response frames received before consumers subscribe', async () => {
    const { proxy, connection } = setup();
    const opening = proxy.openExchange(environmentId, request);
    await vi.waitFor(() =>
      expect(connection.sent.at(-1)?.type).toBe('exchange.open'),
    );
    const frame = connection.sent.at(-1);
    if (frame?.type !== 'exchange.open')
      throw new Error('Expected exchange.open');

    connection.emit({
      version: 2,
      type: 'exchange.opened',
      exchangeId: frame.exchangeId,
      status: 200,
      statusText: 'OK',
      headers: {},
    });
    connection.emit({
      version: 2,
      type: 'exchange.chunk',
      exchangeId: frame.exchangeId,
      data: btoa('fast response'),
    });
    connection.emit({
      version: 2,
      type: 'exchange.close',
      exchangeId: frame.exchangeId,
    });

    const exchange = await opening;
    const chunk = vi.fn();
    const closed = vi.fn();
    exchange.onChunk(chunk);
    exchange.onClose(closed);

    expect(chunk).toHaveBeenCalledWith(btoa('fast response'));
    expect(closed).toHaveBeenCalledWith(undefined);
  });

  it('rejects unavailable environments', async () => {
    const unavailable = createProxy();
    await expect(
      unavailable.openExchange(environmentId, request),
    ).rejects.toThrow('unavailable');
  });

  it('isolates simultaneous exchanges and cancellation', async () => {
    const { proxy, connection } = setup();
    const first = await openExchange(proxy, connection);
    const second = await openExchange(proxy, connection);
    const secondChunk = vi.fn();
    second.onChunk(secondChunk);
    connection.emit({
      version: 2,
      type: 'exchange.chunk',
      exchangeId: second.id,
      data: btoa('two'),
    });
    await first.close();
    expect(secondChunk).toHaveBeenCalledOnce();
    expect(connection.sent.at(-1)).toMatchObject({
      type: 'exchange.close',
      exchangeId: first.id,
    });
  });

  it('rejects aborted, timed out, disconnected, replaced, and failed openings', async () => {
    const aborted = setup();
    const controller = new AbortController();
    const aborting = aborted.proxy.openExchange(environmentId, request, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(aborted.connection.sent).toHaveLength(1));
    controller.abort();
    await expect(aborting).rejects.toThrow();

    const timed = setup(10);
    await expect(
      timed.proxy.openExchange(environmentId, request),
    ).rejects.toThrow();

    const lost = setup();
    const losing = lost.proxy.openExchange(environmentId, request);
    await vi.waitFor(() => expect(lost.connection.sent).toHaveLength(1));
    lost.connection.disconnect(new Error('lost'));
    await expect(losing).rejects.toThrow('lost');

    const replaced = setup();
    const replacing = replaced.proxy.openExchange(environmentId, request);
    await vi.waitFor(() => expect(replaced.connection.sent).toHaveLength(1));
    replaced.proxy.registerEnvironment(environmentId, new TestConnection());
    await expect(replacing).rejects.toThrow('replaced');

    const failed = setup();
    failed.connection.failNextSend = true;
    await expect(
      failed.proxy.openExchange(environmentId, request),
    ).rejects.toThrow('send failed');
  });

  it('closes exchanges on disconnect and shutdown and ignores late frames', async () => {
    const { proxy, connection } = setup();
    const exchange = await openExchange(proxy, connection);
    const closed = vi.fn();
    exchange.onClose(closed);
    connection.disconnect(new Error('lost'));
    expect(closed).toHaveBeenCalledOnce();
    connection.emit({
      version: 2,
      type: 'exchange.close',
      exchangeId: exchange.id,
    });
    await proxy.close();
    await proxy.close();
    await expect(proxy.openExchange(environmentId, request)).rejects.toThrow(
      'Proxy is closed',
    );
  });
});

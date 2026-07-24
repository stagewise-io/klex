import { describe, expect, it, vi } from 'vitest';

import type {
  EnvironmentConnection,
  Unsubscribe,
} from '../connection/index.js';
import {
  createAgentId,
  createEnvironmentId,
  createTenantId,
  type EnvironmentPrincipal,
} from '../identity/index.js';
import {
  createGatewayExchangeId,
  type EnvironmentToGatewayFrame,
  type GatewayToEnvironmentFrame,
} from '../protocol/index.js';
import { createGateway } from './gateway.js';

class TestConnection implements EnvironmentConnection {
  readonly sent: GatewayToEnvironmentFrame[] = [];
  readonly close = vi.fn(async () => undefined);
  failNextSend = false;
  #frameHandlers = new Set<(frame: EnvironmentToGatewayFrame) => void>();
  #closeHandlers = new Set<(cause?: Error) => void>();
  async send(frame: GatewayToEnvironmentFrame): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('send failed');
    }
    this.sent.push(frame);
  }
  onFrame(handler: (frame: EnvironmentToGatewayFrame) => void): Unsubscribe {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }
  onClose(handler: (cause?: Error) => void): Unsubscribe {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }
  emit(frame: EnvironmentToGatewayFrame): void {
    for (const handler of this.#frameHandlers) handler(frame);
  }
  disconnect(cause?: Error): void {
    for (const handler of this.#closeHandlers) handler(cause);
  }
}

const tenantId = createTenantId('tenant-1');
const environmentId = createEnvironmentId('environment-1');
const principal: EnvironmentPrincipal = {
  kind: 'environment',
  tenantId,
  environmentId,
};
const agent = {
  kind: 'agent' as const,
  tenantId,
  agentId: createAgentId('agent-1'),
};
const request = {
  method: 'POST',
  url: 'https://environment.invalid/mcp',
  headers: { accept: 'application/json' },
};

function setup(allowed = true, exchangeOpenTimeoutMs = 30_000) {
  let nextId = 0;
  const gateway = createGateway({
    authorization: { authorize: async () => allowed },
    createExchangeId: () => createGatewayExchangeId(`exchange-${++nextId}`),
    exchangeOpenTimeoutMs,
  });
  const connection = new TestConnection();
  gateway.registerEnvironment(principal, connection);
  return { gateway, connection };
}

async function openExchange(
  gateway: ReturnType<typeof createGateway>,
  connection: TestConnection,
) {
  const opening = gateway.openExchange(agent, environmentId, request);
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

describe('gateway', () => {
  it('opens and routes an authorized exchange', async () => {
    const { gateway, connection } = setup();
    const exchange = await openExchange(gateway, connection);
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

  it('rejects unavailable and unauthorized environments', async () => {
    const unavailable = createGateway({
      authorization: { authorize: async () => true },
    });
    await expect(
      unavailable.openExchange(agent, environmentId, request),
    ).rejects.toThrow('unavailable');
    const { gateway, connection } = setup(false);
    await expect(
      gateway.openExchange(agent, environmentId, request),
    ).rejects.toThrow('not authorized');
    expect(connection.sent).toHaveLength(0);
  });

  it('isolates simultaneous exchanges and cancellation', async () => {
    const { gateway, connection } = setup();
    const first = await openExchange(gateway, connection);
    const second = await openExchange(gateway, connection);
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
    const aborting = aborted.gateway.openExchange(
      agent,
      environmentId,
      request,
      {
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(aborted.connection.sent).toHaveLength(1));
    controller.abort();
    await expect(aborting).rejects.toThrow();

    const timed = setup(true, 10);
    await expect(
      timed.gateway.openExchange(agent, environmentId, request),
    ).rejects.toThrow();

    const lost = setup();
    const losing = lost.gateway.openExchange(agent, environmentId, request);
    await vi.waitFor(() => expect(lost.connection.sent).toHaveLength(1));
    lost.connection.disconnect(new Error('lost'));
    await expect(losing).rejects.toThrow('lost');

    const replaced = setup();
    const replacing = replaced.gateway.openExchange(
      agent,
      environmentId,
      request,
    );
    await vi.waitFor(() => expect(replaced.connection.sent).toHaveLength(1));
    replaced.gateway.registerEnvironment(principal, new TestConnection());
    await expect(replacing).rejects.toThrow('replaced');

    const failed = setup();
    failed.connection.failNextSend = true;
    await expect(
      failed.gateway.openExchange(agent, environmentId, request),
    ).rejects.toThrow('send failed');
  });

  it('closes exchanges on disconnect and shutdown and ignores late frames', async () => {
    const { gateway, connection } = setup();
    const exchange = await openExchange(gateway, connection);
    const closed = vi.fn();
    exchange.onClose(closed);
    connection.disconnect(new Error('lost'));
    expect(closed).toHaveBeenCalledOnce();
    connection.emit({
      version: 2,
      type: 'exchange.close',
      exchangeId: exchange.id,
    });
    await gateway.close();
    await gateway.close();
    await expect(
      gateway.openExchange(agent, environmentId, request),
    ).rejects.toThrow('Gateway is closed');
  });
});

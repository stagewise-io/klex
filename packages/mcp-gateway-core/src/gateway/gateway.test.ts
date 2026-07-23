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
  type GatewayAuthorization,
} from '../identity/index.js';
import {
  createGatewaySessionId,
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
const authorization: GatewayAuthorization = {
  authorize: async () => true,
};

function setup(allowed = true, sessionOpenTimeoutMs = 30_000) {
  let nextId = 0;
  const gateway = createGateway({
    authorization: { authorize: async () => allowed },
    createSessionId: () => createGatewaySessionId(`session-${++nextId}`),
    sessionOpenTimeoutMs,
  });
  const connection = new TestConnection();
  gateway.registerEnvironment(principal, connection);
  return { gateway, connection };
}

async function openSession(
  gateway: ReturnType<typeof createGateway>,
  connection: TestConnection,
) {
  const previousFrameCount = connection.sent.length;
  const opening = gateway.openSession(agent, environmentId);
  await vi.waitFor(() =>
    expect(connection.sent).toHaveLength(previousFrameCount + 1),
  );
  const frame = connection.sent[previousFrameCount];
  if (frame?.type !== 'session.open') throw new Error('Expected session.open');
  connection.emit({
    version: 1,
    type: 'session.opened',
    sessionId: frame.sessionId,
  });
  return opening;
}

describe('gateway', () => {
  it('opens an authorized session after environment acknowledgement', async () => {
    const { gateway, connection } = setup();
    const session = await openSession(gateway, connection);

    expect(session.id).toBe('session-1');
  });

  it('rejects unavailable and unauthorized environments', async () => {
    const unavailable = createGateway({ authorization });
    await expect(unavailable.openSession(agent, environmentId)).rejects.toThrow(
      'unavailable',
    );

    const { gateway, connection } = setup(false);
    await expect(gateway.openSession(agent, environmentId)).rejects.toThrow(
      'not authorized',
    );
    expect(connection.sent).toHaveLength(0);
  });

  it('routes messages in both directions', async () => {
    const { gateway, connection } = setup();
    const session = await openSession(gateway, connection);
    const received = vi.fn();
    session.onMessage(received);
    const request = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };
    const response = { jsonrpc: '2.0' as const, id: 1, result: {} };

    await session.send(request);
    connection.emit({
      version: 1,
      type: 'session.message',
      sessionId: session.id,
      message: response,
    });

    expect(connection.sent.at(-1)).toEqual({
      version: 1,
      type: 'session.message',
      sessionId: session.id,
      message: request,
    });
    expect(received).toHaveBeenCalledWith(response);
  });

  it('isolates simultaneous sessions', async () => {
    const { gateway, connection } = setup();
    const first = await openSession(gateway, connection);
    const second = await openSession(gateway, connection);
    const firstReceived = vi.fn();
    const secondReceived = vi.fn();
    first.onMessage(firstReceived);
    second.onMessage(secondReceived);
    const message = { jsonrpc: '2.0' as const, method: 'notifications/test' };

    connection.emit({
      version: 1,
      type: 'session.message',
      sessionId: second.id,
      message,
    });

    expect(firstReceived).not.toHaveBeenCalled();
    expect(secondReceived).toHaveBeenCalledWith(message);
  });

  it('closes one session without affecting another', async () => {
    const { gateway, connection } = setup();
    const first = await openSession(gateway, connection);
    const second = await openSession(gateway, connection);
    const secondClosed = vi.fn();
    second.onClose(secondClosed);

    await first.close();
    await second.send({ jsonrpc: '2.0', method: 'notifications/test' });

    expect(connection.sent).toContainEqual({
      version: 1,
      type: 'session.close',
      sessionId: first.id,
    });
    expect(secondClosed).not.toHaveBeenCalled();
  });

  it('closes all sessions when an environment disconnects', async () => {
    const { gateway, connection } = setup();
    const first = await openSession(gateway, connection);
    const second = await openSession(gateway, connection);
    const firstClosed = vi.fn();
    const secondClosed = vi.fn();
    first.onClose(firstClosed);
    second.onClose(secondClosed);

    connection.disconnect(new Error('lost'));

    expect(firstClosed).toHaveBeenCalled();
    expect(secondClosed).toHaveBeenCalled();
    await expect(
      first.send({ jsonrpc: '2.0', method: 'test' }),
    ).rejects.toThrow('closed');
  });

  it('replaces an existing environment connection', async () => {
    const { gateway, connection: firstConnection } = setup();
    const session = await openSession(gateway, firstConnection);
    const closed = vi.fn();
    session.onClose(closed);
    const secondConnection = new TestConnection();

    gateway.registerEnvironment(principal, secondConnection);

    expect(closed).toHaveBeenCalled();
    expect(firstConnection.close).toHaveBeenCalledOnce();
    await openSession(gateway, secondConnection);
  });

  it('cleans up an aborted opening and ignores its late acknowledgement', async () => {
    const { gateway, connection } = setup();
    const controller = new AbortController();
    const opening = gateway.openSession(agent, environmentId, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    const openFrame = connection.sent[0];
    if (openFrame?.type !== 'session.open')
      throw new Error('Expected session.open');

    controller.abort();

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.sent.at(-1)?.type).toBe('session.close');
    connection.emit({
      version: 1,
      type: 'session.opened',
      sessionId: openFrame.sessionId,
    });
    expect(connection.close).not.toHaveBeenCalled();
    await openSession(gateway, connection);
  });

  it('times out an opening and ignores its late acknowledgement', async () => {
    const { gateway, connection } = setup(true, 50);
    const opening = gateway.openSession(agent, environmentId);
    const rejection = expect(opening).rejects.toThrow('timed out');
    await vi.waitFor(() =>
      expect(connection.sent[0]?.type).toBe('session.open'),
    );
    const openFrame = connection.sent[0];
    if (openFrame?.type !== 'session.open')
      throw new Error('Expected session.open');

    await rejection;
    connection.emit({
      version: 1,
      type: 'session.opened',
      sessionId: openFrame.sessionId,
    });

    expect(connection.close).not.toHaveBeenCalled();
    await openSession(gateway, connection);
  });

  it('rejects an opening when the environment disconnects', async () => {
    const { gateway, connection } = setup();
    const opening = gateway.openSession(agent, environmentId);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));

    connection.disconnect(new Error('lost'));

    await expect(opening).rejects.toThrow('lost');
  });

  it('rejects an opening when the environment connection is replaced', async () => {
    const { gateway, connection } = setup();
    const opening = gateway.openSession(agent, environmentId);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));

    gateway.registerEnvironment(principal, new TestConnection());

    await expect(opening).rejects.toThrow('replaced');
  });

  it('cleans up an opening when sending session.open fails', async () => {
    const { gateway, connection } = setup();
    connection.failNextSend = true;

    await expect(gateway.openSession(agent, environmentId)).rejects.toThrow(
      'send failed',
    );

    await openSession(gateway, connection);
  });

  it('closes registrations and sessions on shutdown', async () => {
    const { gateway, connection } = setup();
    const session = await openSession(gateway, connection);
    const closed = vi.fn();
    session.onClose(closed);

    await gateway.close();

    expect(closed).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
    await expect(gateway.openSession(agent, environmentId)).rejects.toThrow(
      'Gateway is closed',
    );
  });
});

import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  EVENTS_EVENT_NOTIFICATION,
  EVENTS_EXTENSION_ID,
  EVENTS_STREAM_METHOD,
  SUBSCRIPTION_ID_META_KEY,
} from '../constants.js';

type Msg = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
};

/** Minimal server-side peer over a hand-rolled Transport. */
function makeTransport(log: Msg[]) {
  const transport: any = {
    onmessage: undefined as ((m: Msg) => void) | undefined,
    onclose: undefined,
    onerror: undefined,
    async start() {},
    async close() {},
    async send(message: Msg) {
      log.push(message);
      if (message.method === 'initialize') {
        queueMicrotask(() =>
          transport.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: message.params?.['protocolVersion'],
              capabilities: { extensions: { [EVENTS_EXTENSION_ID]: {} } },
              serverInfo: { name: 'fake', version: '0' },
            },
          }),
        );
      }
      if (message.method === 'server/discover') {
        queueMicrotask(() =>
          transport.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              supportedVersions: ['2026-07-28'],
              capabilities: { extensions: { [EVENTS_EXTENSION_ID]: {} } },
              serverInfo: { name: 'fake', version: '0' },
            },
          }),
        );
      }
      if (message.method === EVENTS_STREAM_METHOD) {
        queueMicrotask(() =>
          transport.onmessage?.({
            jsonrpc: '2.0',
            method: EVENTS_EVENT_NOTIFICATION,
            params: {
              eventId: 'e1',
              name: 'x',
              timestamp: '2026-01-01T00:00:00Z',
              data: {},
              _meta: { [SUBSCRIPTION_ID_META_KEY]: message.id },
            },
          }),
        );
      }
    },
  };
  return transport;
}

describe('SDK spike: events/stream on the real Client', () => {
  it('exposes the request id on the wire and routes custom notifications', async () => {
    const log: Msg[] = [];
    const transport = makeTransport(log);
    const client = new Client({ name: 'spike', version: '0' }, {} as never);
    const received: any[] = [];
    client.setNotificationHandler(
      EVENTS_EVENT_NOTIFICATION,
      { params: z.looseObject({}) },
      async (params: any) => {
        received.push(params);
      },
    );
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error(`connect hung; wire: ${JSON.stringify(log)}`)),
          1500,
        ),
      ),
    ]);

    void client
      .request(
        { method: EVENTS_STREAM_METHOD, params: { name: 'x', cursor: null } },
        z.looseObject({}),
        { onprogress: () => undefined, resetTimeoutOnProgress: true },
      )
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    const sent = log.find((m) => m.method === EVENTS_STREAM_METHOD);
    expect(sent?.id).toBeTypeOf('number');
    expect(received).toHaveLength(1);
    expect(received[0]._meta[SUBSCRIPTION_ID_META_KEY]).toBe(sent?.id);
    await client.close();
  });
});

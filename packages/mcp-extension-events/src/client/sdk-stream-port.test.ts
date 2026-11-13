import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import {
  EVENTS_ACTIVE_NOTIFICATION,
  EVENTS_EVENT_NOTIFICATION,
  EVENTS_EXTENSION_ID,
  EVENTS_STREAM_METHOD,
  SUBSCRIPTION_ID_META_KEY,
} from '../constants.js';
import { createRequestIdTap, createSdkStreamPort } from './sdk-stream-port.js';
import type { StreamSink } from './stream-driver.js';

type Msg = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
};

function makeTransport(log: Msg[]) {
  const transport: any = {
    onmessage: undefined as ((m: Msg) => void) | undefined,
    async start() {},
    async close() {},
    async send(message: Msg) {
      log.push(message);
      const reply = (m: object) =>
        queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', ...m }));
      if (message.method === 'initialize') {
        reply({
          id: message.id,
          result: {
            protocolVersion: message.params?.['protocolVersion'],
            capabilities: { extensions: { [EVENTS_EXTENSION_ID]: {} } },
            serverInfo: { name: 'fake', version: '0' },
          },
        });
      }
      if (message.method === EVENTS_STREAM_METHOD) {
        const name = message.params?.['name'];
        const meta = { [SUBSCRIPTION_ID_META_KEY]: message.id };
        reply({
          method: EVENTS_ACTIVE_NOTIFICATION,
          params: { cursor: `${name}-0`, heartbeatMs: 1000, _meta: meta },
        });
        reply({
          method: EVENTS_EVENT_NOTIFICATION,
          params: {
            eventId: `${name}-1`,
            name,
            timestamp: '2026-01-01T00:00:00Z',
            data: {},
            cursor: `${name}-1`,
            _meta: meta,
          },
        });
      }
    },
  };
  return transport;
}

function recorder() {
  const got: string[] = [];
  const sink: StreamSink = {
    active: (p) => void got.push(`active:${p.cursor}`),
    event: (p) => void got.push(`event:${p.eventId}`),
    heartbeat: () => undefined,
    error: () => undefined,
    terminated: () => undefined,
  };
  return { got, sink };
}

describe('createSdkStreamPort (real SDK Client)', () => {
  it('demultiplexes two concurrent streams by subscription id', async () => {
    const log: Msg[] = [];
    const transport = makeTransport(log);
    const tap = createRequestIdTap(transport);
    const client = new Client({ name: 'port', version: '0' }, {} as never);
    await client.connect(transport);
    const port = createSdkStreamPort(client, tap);

    const a = recorder();
    const b = recorder();
    const abort = new AbortController();
    const opens = [
      port.open({ name: 'a', cursor: null }, a.sink, abort.signal),
      port.open({ name: 'b', cursor: null }, b.sink, abort.signal),
    ];
    await new Promise((r) => setTimeout(r, 50));

    expect(a.got).toEqual(['active:a-0', 'event:a-1']);
    expect(b.got).toEqual(['active:b-0', 'event:b-1']);

    const sent = log.filter((m) => m.method === EVENTS_STREAM_METHOD);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.id).not.toBe(sent[1]?.id);

    abort.abort();
    await Promise.all(opens);
    await client.close();
  });
});

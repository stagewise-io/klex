import { describe, expect, it } from 'vitest';

import {
  createProxyExchangeId,
  decodeEnvironmentToProxyFrame,
  decodeProxyToEnvironmentFrame,
  type EnvironmentToProxyFrame,
  encodeProxyFrame,
  type ProxyToEnvironmentFrame,
} from './protocol.js';

const exchangeId = createProxyExchangeId('exchange-1');

const open: ProxyToEnvironmentFrame = {
  version: 2,
  type: 'exchange.open',
  exchangeId,
  method: 'POST',
  url: 'https://environment.invalid/mcp',
  headers: { accept: 'application/json' },
  body: btoa('{}'),
};

describe('proxy protocol', () => {
  it.each<ProxyToEnvironmentFrame>([
    open,
    { version: 2, type: 'exchange.close', exchangeId },
  ])('round-trips proxy frame $type', (frame) => {
    expect(decodeProxyToEnvironmentFrame(encodeProxyFrame(frame))).toEqual(
      frame,
    );
  });

  it.each<EnvironmentToProxyFrame>([
    {
      version: 2,
      type: 'exchange.opened',
      exchangeId,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    },
    { version: 2, type: 'exchange.chunk', exchangeId, data: btoa('hello') },
    { version: 2, type: 'exchange.close', exchangeId },
    { version: 2, type: 'exchange.close', exchangeId, reason: 'failed' },
  ])('round-trips environment frame $type', (frame) => {
    expect(decodeEnvironmentToProxyFrame(encodeProxyFrame(frame))).toEqual(
      frame,
    );
  });

  it('rejects malformed JSON, versions, directions, and identifiers', () => {
    expect(() => decodeProxyToEnvironmentFrame('{')).toThrow();
    expect(() =>
      decodeProxyToEnvironmentFrame(JSON.stringify({ ...open, version: 1 })),
    ).toThrow();
    expect(() =>
      decodeProxyToEnvironmentFrame(
        JSON.stringify({
          version: 2,
          type: 'exchange.opened',
          exchangeId,
          status: 200,
          statusText: 'OK',
          headers: {},
        }),
      ),
    ).toThrow();
    expect(() => createProxyExchangeId(' exchange ')).toThrow();
  });

  it('rejects malformed metadata and unknown properties', () => {
    for (const mutation of [
      { ...open, body: '*' },
      { ...open, method: 'post' },
      { ...open, headers: { bad: 'line\nbreak' } },
      { ...open, unexpected: true },
    ]) {
      expect(() =>
        decodeProxyToEnvironmentFrame(JSON.stringify(mutation)),
      ).toThrow();
    }
    expect(() =>
      decodeEnvironmentToProxyFrame(
        JSON.stringify({
          version: 2,
          type: 'exchange.opened',
          exchangeId,
          status: 99,
          statusText: 'Bad\nStatus',
          headers: {},
        }),
      ),
    ).toThrow();
  });
});

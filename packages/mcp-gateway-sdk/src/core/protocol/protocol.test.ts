import { describe, expect, it } from 'vitest';

import {
  createGatewayExchangeId,
  decodeEnvironmentToGatewayFrame,
  decodeGatewayToEnvironmentFrame,
  type EnvironmentToGatewayFrame,
  encodeGatewayFrame,
  type GatewayToEnvironmentFrame,
} from './protocol.js';

const exchangeId = createGatewayExchangeId('exchange-1');

const open: GatewayToEnvironmentFrame = {
  version: 2,
  type: 'exchange.open',
  exchangeId,
  method: 'POST',
  url: 'https://environment.invalid/mcp',
  headers: { accept: 'application/json' },
  body: btoa('{}'),
};

describe('gateway protocol', () => {
  it.each<GatewayToEnvironmentFrame>([
    open,
    { version: 2, type: 'exchange.close', exchangeId },
  ])('round-trips gateway frame $type', (frame) => {
    expect(decodeGatewayToEnvironmentFrame(encodeGatewayFrame(frame))).toEqual(
      frame,
    );
  });

  it.each<EnvironmentToGatewayFrame>([
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
    expect(decodeEnvironmentToGatewayFrame(encodeGatewayFrame(frame))).toEqual(
      frame,
    );
  });

  it('rejects malformed JSON, versions, directions, and identifiers', () => {
    expect(() => decodeGatewayToEnvironmentFrame('{')).toThrow();
    expect(() =>
      decodeGatewayToEnvironmentFrame(JSON.stringify({ ...open, version: 1 })),
    ).toThrow();
    expect(() =>
      decodeGatewayToEnvironmentFrame(
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
    expect(() => createGatewayExchangeId(' exchange ')).toThrow();
  });

  it('rejects malformed metadata and unknown properties', () => {
    for (const mutation of [
      { ...open, body: '*' },
      { ...open, method: 'post' },
      { ...open, headers: { bad: 'line\nbreak' } },
      { ...open, unexpected: true },
    ]) {
      expect(() =>
        decodeGatewayToEnvironmentFrame(JSON.stringify(mutation)),
      ).toThrow();
    }
    expect(() =>
      decodeEnvironmentToGatewayFrame(
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

import { describe, expect, it } from 'vitest';

import {
  createGatewaySessionId,
  decodeEnvironmentToGatewayFrame,
  decodeGatewayToEnvironmentFrame,
  encodeGatewayFrame,
  type GatewayToEnvironmentFrame,
} from './protocol.js';

const sessionId = createGatewaySessionId('session-1');

const message = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/list',
};

describe('gateway protocol', () => {
  it.each<GatewayToEnvironmentFrame>([
    { version: 1, type: 'session.open', sessionId },
    {
      version: 1,
      type: 'session.message',
      sessionId,
      message,
      options: { relatedRequestId: 1 },
    },
    { version: 1, type: 'session.close', sessionId },
  ])('round-trips gateway frame $type', (frame) => {
    expect(decodeGatewayToEnvironmentFrame(encodeGatewayFrame(frame))).toEqual(
      frame,
    );
  });

  it.each([
    { version: 1, type: 'session.opened', sessionId },
    {
      version: 1,
      type: 'session.message',
      sessionId,
      message,
      options: { relatedRequestId: 'request-1' },
    },
    { version: 1, type: 'session.close', sessionId },
  ])('round-trips environment frame $type', (frame) => {
    expect(decodeEnvironmentToGatewayFrame(JSON.stringify(frame))).toEqual(
      frame,
    );
  });

  it('rejects malformed JSON', () => {
    expect(() => decodeGatewayToEnvironmentFrame('{')).toThrow();
  });

  it('rejects unsupported versions', () => {
    expect(() =>
      decodeGatewayToEnvironmentFrame(
        JSON.stringify({ version: 2, type: 'session.open', sessionId }),
      ),
    ).toThrow();
  });

  it('rejects frames sent in the wrong direction', () => {
    expect(() =>
      decodeGatewayToEnvironmentFrame(
        JSON.stringify({ version: 1, type: 'session.opened', sessionId }),
      ),
    ).toThrow();
  });

  it.each(['', ' session-1 '])('rejects invalid session ID %j', (value) => {
    expect(() => createGatewaySessionId(value)).toThrow();
  });

  it('rejects invalid MCP messages', () => {
    expect(() =>
      decodeEnvironmentToGatewayFrame(
        JSON.stringify({
          version: 1,
          type: 'session.message',
          sessionId,
          message: { hello: 'world' },
        }),
      ),
    ).toThrow();
  });

  it('rejects invalid message options', () => {
    expect(() =>
      decodeGatewayToEnvironmentFrame(
        JSON.stringify({
          version: 1,
          type: 'session.message',
          sessionId,
          message,
          options: { unexpected: true },
        }),
      ),
    ).toThrow();
  });

  it('rejects unknown properties', () => {
    expect(() =>
      decodeGatewayToEnvironmentFrame(
        JSON.stringify({
          version: 1,
          type: 'session.open',
          sessionId,
          unexpected: true,
        }),
      ),
    ).toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import { GeminiWireEventError, parseGeminiServerEvent } from './wire-events';

describe('parseGeminiServerEvent', () => {
  it('parses setup, multi-part content, status, tools, cancellation, and lifetime events', () => {
    expect(parseGeminiServerEvent('{"setupComplete":{}}')).toEqual({
      type: 'setup-complete',
    });
    expect(
      parseGeminiServerEvent(
        JSON.stringify({
          serverContent: {
            modelTurn: {
              parts: [
                { text: 'hello' },
                {
                  inlineData: {
                    mimeType: 'audio/pcm;rate=24000',
                    data: 'AQI=',
                  },
                },
              ],
            },
            inputTranscription: { text: 'in' },
            outputTranscription: { text: 'out' },
            interrupted: true,
            turnComplete: true,
            interactionStatus: 'IN_PROGRESS',
          },
        }),
      ),
    ).toMatchObject({
      type: 'server-content',
      text: ['hello'],
      audio: ['AQI='],
      inputTranscript: 'in',
      outputTranscript: 'out',
      interrupted: true,
      turnComplete: true,
      interactionStatus: 'IN_PROGRESS',
    });
    expect(
      parseGeminiServerEvent(
        JSON.stringify({
          toolCall: { functionCalls: [{ id: '1', name: 'clock', args: {} }] },
        }),
      ),
    ).toMatchObject({ type: 'tool-call', calls: [{ id: '1', name: 'clock' }] });
    expect(
      parseGeminiServerEvent(
        JSON.stringify({ toolCallCancellation: { ids: ['1'] } }),
      ),
    ).toEqual({ type: 'tool-call-cancellation', ids: ['1'] });
    expect(
      parseGeminiServerEvent(
        JSON.stringify({
          sessionResumptionUpdate: { newHandle: 'h', resumable: true },
        }),
      ),
    ).toEqual({ type: 'resumption-update', handle: 'h', resumable: true });
    expect(parseGeminiServerEvent('{"goAway":{"timeLeft":"2s"}}')).toEqual({
      type: 'go-away',
      timeLeft: '2s',
    });
  });

  it('rejects malformed consumed payloads and ignores forward-compatible events', () => {
    expect(() => parseGeminiServerEvent('nope')).toThrow(GeminiWireEventError);
    expect(() =>
      parseGeminiServerEvent('{"toolCall":{"functionCalls":"bad"}}'),
    ).toThrow('toolCall.functionCalls');
    expect(() =>
      parseGeminiServerEvent(
        JSON.stringify({
          serverContent: {
            modelTurn: {
              parts: [{ inlineData: { mimeType: 'audio/pcm', data: '!' } }],
            },
          },
        }),
      ),
    ).toThrow('valid base64');
    expect(parseGeminiServerEvent('{"futureEvent":{}}')).toEqual({
      type: 'ignored',
      name: 'futureEvent',
    });
  });
});

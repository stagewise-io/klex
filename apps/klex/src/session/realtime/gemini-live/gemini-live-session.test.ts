import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { AudioFrame, AudioSource } from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';
import type { SessionInboxEvent } from '@/session/inbox';
import type { PreparedInferenceContext } from '@/session/interaction';

import { toGeminiContentTurns } from './conversation-items';
import {
  createGeminiLiveProcessorFactory,
  type GeminiRealtimeWebSocket,
} from './gemini-live-session';

class FakeSocket extends EventEmitter implements GeminiRealtimeWebSocket {
  readyState = 0;
  sent: string[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });
  terminate = vi.fn(() => {
    this.readyState = 3;
  });
  send(data: string): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  message(event: object): void {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}

const warn = vi.fn();
const debug = vi.fn();
const logging = {
  child: () => ({ warn, debug }),
} as unknown as RootLogger;

const config = {
  modelId: 'gemini-3.8-live',
  apiKey: 'test-google-key',
  websocketUrl:
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=test-google-key',
};

function frame(sampleCount = 960): AudioFrame {
  const data = new Uint8Array(sampleCount * 2);
  const view = new DataView(data.buffer);
  for (let index = 0; index < sampleCount; index += 1)
    view.setInt16(index * 2, index % 100, true);
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 48_000,
    channels: 1,
    sequence: 0,
    timestampUs: 0,
    data,
  };
}

function source(queue: BoundedAsyncQueue<AudioFrame>): AudioSource {
  return {
    id: 'microphone',
    metadata: { participantId: 'caller', trackId: 'microphone' },
    readable: queue,
    closed: new Promise(() => undefined),
  };
}

async function setup(
  startupTimeoutMs = 1_000,
  contextOverride?: Partial<PreparedInferenceContext>,
) {
  const socket = new FakeSocket();
  const factory = createGeminiLiveProcessorFactory({
    logging,
    config,
    startupTimeoutMs,
    connect: () => socket,
  });
  const controller = new AbortController();
  const promise = factory.create({
    namespace: 'test',
    sessionId: 'session',
    signal: controller.signal,
    context: {
      model: {
        modelId: 'gemini-3.8-live',
        contextSize: 131_072,
        inputCapabilities: {},
      },
      instructions: 'You are Klex Gemini.',
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      ],
      messages: [],
      historyRevision: 1,
      updateWatermark: 0,
      ...contextOverride,
    },
  });
  return { socket, promise, controller };
}

async function activate(contextOverride?: Partial<PreparedInferenceContext>) {
  const harness = await setup(1_000, contextOverride);
  harness.socket.open();
  const setupMsg = JSON.parse(harness.socket.sent[0] ?? '{}');
  harness.socket.message({ setupComplete: {} });
  const processor = await harness.promise;
  return { ...harness, setupMsg, processor };
}

describe('Gemini live processor', () => {
  it('sends setup message with model, instructions, transcription, and tools on open', async () => {
    const harness = await setup();
    let settled = false;
    void harness.promise.then(() => {
      settled = true;
    });
    harness.socket.open();
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(harness.socket.sent.length).toBe(1);
    const setupMsg = JSON.parse(harness.socket.sent[0] ?? '{}');
    expect(setupMsg.setup.model).toBe('models/gemini-3.8-live');
    expect(setupMsg.setup.generationConfig.responseModalities).toEqual([
      'AUDIO',
    ]);
    expect(setupMsg.setup.inputAudioTranscription).toEqual({});
    expect(setupMsg.setup.outputAudioTranscription).toEqual({});
    expect(setupMsg.setup.systemInstruction.parts[0].text).toBe(
      'You are Klex Gemini.',
    );
    expect(setupMsg.setup.tools[0].functionDeclarations[0].name).toBe(
      'get_weather',
    );

    harness.socket.message({ setupComplete: {} });
    await expect(harness.promise).resolves.toBeDefined();
  });

  it('seeds prior canonical conversation history on setupComplete', async () => {
    const harness = await setup(1_000, {
      messages: [
        { role: 'user', content: 'What is the weather today?' },
        { role: 'assistant', content: 'It is 22 degrees and sunny.' },
      ],
    });
    harness.socket.open();
    expect(harness.socket.sent.length).toBe(1);

    harness.socket.message({ setupComplete: {} });
    await harness.promise;

    expect(harness.socket.sent.length).toBe(2);
    const seedMsg = JSON.parse(harness.socket.sent[1] ?? '{}');
    expect(seedMsg.clientContent).toBeDefined();
    expect(seedMsg.clientContent.turnComplete).toBe(false);
    expect(seedMsg.clientContent.turns).toEqual([
      {
        role: 'user',
        parts: [{ text: 'What is the weather today?' }],
      },
      {
        role: 'model',
        parts: [{ text: 'It is 22 degrees and sunny.' }],
      },
    ]);
  });

  it('sends background context update as clientContent with turnComplete: false', async () => {
    const { socket, processor } = await activate();
    await processor.sendUpdate({
      sequence: 1,
      eventId: 'evt-1',
      requestResponse: false,
      event: {
        context: {
          sourceEnv: 'system',
          metadata: { memoryId: 'mem-1' },
          content: [{ type: 'text', text: 'User prefers metric units' }],
        },
      } as unknown as SessionInboxEvent,
    });

    const updateMsg = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(updateMsg.clientContent).toBeDefined();
    expect(updateMsg.clientContent.turnComplete).toBe(false);
    expect(updateMsg.clientContent.turns[0].role).toBe('user');
    expect(updateMsg.clientContent.turns[0].parts[0].text).toContain(
      'User prefers metric units',
    );
    await processor.close();
  });

  it('sends responsive context update as clientContent with turnComplete: true', async () => {
    const { socket, processor } = await activate();
    await processor.sendUpdate({
      sequence: 2,
      eventId: 'evt-2',
      requestResponse: true,
      event: {
        context: {
          sourceEnv: 'system',
          metadata: { reminderId: 'rem-1' },
          content: [{ type: 'text', text: 'New urgent reminder' }],
        },
      } as unknown as SessionInboxEvent,
    });

    const updateMsg = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(updateMsg.clientContent).toBeDefined();
    expect(updateMsg.clientContent.turnComplete).toBe(true);
    expect(updateMsg.clientContent.turns[0].role).toBe('user');
    expect(updateMsg.clientContent.turns[0].parts[0].text).toContain(
      'New urgent reminder',
    );
    await processor.close();
  });

  it('downsamples incoming 48kHz audio to 24kHz and sends realtimeInput', async () => {
    const { socket, processor } = await activate();
    const input = new BoundedAsyncQueue<AudioFrame>(1);
    await processor.audioInputs.attach(source(input));
    await input.push(frame());
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(1));

    const audioMsg = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(audioMsg.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=24000');
    expect(
      Buffer.from(audioMsg.realtimeInput.audio.data, 'base64'),
    ).toHaveLength(960);
    await processor.close();
  });

  it('packetizes incoming 24kHz audio from model into 48kHz 20ms frames', async () => {
    const { socket, processor } = await activate();
    const audio24 = Buffer.alloc(480 * 2, 1).toString('base64');
    socket.message({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: audio24 } },
          ],
        },
      },
    });

    const output = await processor.audioOutput[Symbol.asyncIterator]().next();
    expect(output.value).toMatchObject({
      sampleRateHz: 48_000,
      channels: 1,
      sequence: 0,
      timestampUs: 0,
    });
    expect(output.value?.data).toHaveLength(1_920);
    await processor.close();
  });

  it('handles server interruptions, clears queued audio, and emits interrupted transcript', async () => {
    const { socket, processor } = await activate();
    const eventsIterator = processor.events[Symbol.asyncIterator]();

    const audio24 = Buffer.alloc(480 * 2 * 5, 2).toString('base64');
    socket.message({
      serverContent: {
        outputTranscription: { text: 'Speaking something...' },
        modelTurn: {
          parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: audio24 } },
          ],
        },
      },
    });

    // An interruption arrives
    socket.message({
      serverContent: {
        interrupted: true,
      },
    });

    const event = await eventsIterator.next();
    expect(event.value).toMatchObject({
      type: 'assistant-transcript',
      text: 'Speaking something...',
      interrupted: true,
    });

    await processor.close();
  });

  it('handles turn completion with full assistant transcript', async () => {
    const { socket, processor } = await activate();
    const eventsIterator = processor.events[Symbol.asyncIterator]();

    socket.message({
      serverContent: {
        outputTranscription: { text: 'Hello from Gemini!' },
        turnComplete: true,
      },
    });

    const event = await eventsIterator.next();
    expect(event.value).toMatchObject({
      type: 'assistant-transcript',
      text: 'Hello from Gemini!',
    });
    await processor.close();
  });

  it('handles tool calls and sends tool responses back to session', async () => {
    const { socket, processor } = await activate();
    const eventsIterator = processor.events[Symbol.asyncIterator]();

    socket.message({
      toolCall: {
        functionCalls: [
          {
            id: 'call-123',
            name: 'get_weather',
            args: { city: 'Berlin' },
          },
        ],
      },
    });

    const event = await eventsIterator.next();
    expect(event.value).toMatchObject({
      type: 'tool-call',
      eventId: 'call-123',
      request: {
        executionId: 'call-123',
        name: 'get_weather',
        input: { city: 'Berlin' },
      },
    });

    await processor.sendToolResult({
      executionId: 'call-123',
      status: 'success',
      output: { temperature: 18, unit: 'C' },
    });

    const toolResponseMsg = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(toolResponseMsg.toolResponse.functionResponses[0]).toEqual({
      id: 'call-123',
      name: 'get_weather',
      response: {
        result: { temperature: 18, unit: 'C' },
      },
    });
    await processor.close();
  });

  it('handles provider error and reports failure', async () => {
    const harness = await setup();
    harness.socket.open();
    harness.socket.message({
      error: {
        code: 400,
        message: 'Invalid model parameter',
        status: 'INVALID_ARGUMENT',
      },
    });
    await expect(harness.promise).rejects.toThrow('Invalid model parameter');
  });

  it('handles abort signal and closes socket cleanly', async () => {
    const { controller, socket, processor } = await activate();
    controller.abort();
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalled());
    await expect(processor.closed).resolves.toMatchObject({
      type: 'closed',
      reason: 'aborted',
    });
  });
});

describe('toGeminiContentTurns', () => {
  it('converts user, assistant, system, and tool messages to Gemini Content turns', () => {
    const turns = toGeminiContentTurns([
      { role: 'system', content: 'Act as a concise assistant.' },
      { role: 'user', content: 'What is the capital of France?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'search',
            input: { query: 'capital of France' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'search',
            output: { type: 'json', value: { result: 'Paris' } },
          },
        ],
      },
      { role: 'assistant', content: 'The capital of France is Paris.' },
    ]);

    expect(turns).toEqual([
      {
        role: 'user',
        parts: [{ text: '[System Instruction]:\nAct as a concise assistant.' }],
      },
      {
        role: 'user',
        parts: [{ text: 'What is the capital of France?' }],
      },
      {
        role: 'model',
        parts: [
          { text: 'Let me check.' },
          {
            functionCall: {
              id: 'call_1',
              name: 'search',
              args: { query: 'capital of France' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_1',
              name: 'search',
              response: { result: 'Paris' },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ text: 'The capital of France is Paris.' }],
      },
    ]);
  });
});

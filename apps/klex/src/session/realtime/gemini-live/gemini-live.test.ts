import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { ResolvedGeminiLiveConfig } from '@/config';

import {
  createGeminiLiveProcessorFactory,
  type GeminiLiveWebSocket,
} from './gemini-live';

class FakeSocket extends EventEmitter implements GeminiLiveWebSocket {
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
const logging = {
  child: () => ({ warn, debug: vi.fn() }),
} as unknown as RootLogger;
const config: ResolvedGeminiLiveConfig = {
  modelId: 'gemini-3.8-live',
  apiKey: 'secret',
  websocketUrl: 'wss://example.test/live',
};

async function setup(modelConfig = config) {
  const socket = new FakeSocket();
  let connectedUrl = '';
  const factory = createGeminiLiveProcessorFactory({
    logging,
    config: modelConfig,
    connect: (url) => {
      connectedUrl = url;
      return socket;
    },
  });
  const creation = factory.create({
    namespace: 'test',
    sessionId: 'session',
    signal: new AbortController().signal,
  });
  socket.open();
  expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
    setup: { model: `models/${modelConfig.modelId}` },
  });
  socket.message({ setupComplete: {} });
  return { session: await creation, socket, connectedUrl };
}

async function next<T>(iterable: AsyncIterable<T>): Promise<T> {
  const item = await iterable[Symbol.asyncIterator]().next();
  if (item.done) throw new Error('stream ended');
  return item.value;
}

describe('GeminiLiveSession', () => {
  it('authenticates in the URL without including credentials in setup', async () => {
    const { session, socket, connectedUrl } = await setup();
    expect(connectedUrl).toContain('key=secret');
    expect(socket.sent[0]).not.toContain('secret');
    await session.close();
    expect((await session.closed).type).toBe('closed');
  });

  it('emits audio, transcripts, tool calls, and cancellation', async () => {
    const { session, socket } = await setup();
    const audio = Buffer.alloc(960, 1).toString('base64');
    socket.message({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: audio } },
          ],
        },
        inputTranscription: { text: 'hello' },
        outputTranscription: { text: 'hi there' },
        turnComplete: true,
      },
    });
    expect(await next(session.audioOutput)).toMatchObject({
      encoding: 'pcm-s16le',
      sampleRateHz: 48_000,
      channels: 1,
    });
    await expect(next(session.events)).resolves.toMatchObject({
      type: 'user-transcript',
      text: 'hello',
    });
    await expect(next(session.events)).resolves.toMatchObject({
      type: 'assistant-transcript',
      text: 'hi there',
    });

    socket.message({
      toolCall: {
        functionCalls: [{ id: 'call-1', name: 'clock', args: { zone: 'UTC' } }],
      },
    });
    await expect(next(session.events)).resolves.toMatchObject({
      type: 'tool-call',
      request: { executionId: 'call-1', name: 'clock', input: { zone: 'UTC' } },
    });
    socket.message({ toolCallCancellation: { ids: ['call-1'] } });
    await expect(next(session.events)).resolves.toMatchObject({
      type: 'tool-call-cancelled',
      executionId: 'call-1',
    });
    await session.sendToolResult({
      executionId: 'call-1',
      status: 'success',
      output: 'late',
    });
    expect(
      socket.sent.some((message) => message.includes('toolResponse')),
    ).toBe(false);
    await session.close();
  });

  it('resumes after a provider rotation without reseeding history', async () => {
    vi.useFakeTimers();
    const sockets = [new FakeSocket(), new FakeSocket()];
    let index = 0;
    const factory = createGeminiLiveProcessorFactory({
      logging,
      config,
      reconnect: { delayMs: 1 },
      connect: () => sockets[index++]!,
    });
    const creation = factory.create({
      namespace: 'test',
      sessionId: 'session',
      signal: new AbortController().signal,
      context: {
        instructions: 'test',
        messages: [{ role: 'user', content: 'seed' }],
        tools: [],
        model: {
          modelId: config.modelId,
          contextSize: 131_072,
          inputCapabilities: {},
        },
        historyRevision: 1,
        updateWatermark: 0,
      },
    });
    sockets[0]!.open();
    sockets[0]!.message({ setupComplete: {} });
    const session = await creation;
    sockets[0]!.message({
      sessionResumptionUpdate: { newHandle: 'resume-handle', resumable: true },
    });
    sockets[0]!.message({ goAway: { timeLeft: '2s' } });
    await vi.advanceTimersByTimeAsync(1);
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0] ?? '{}')).toMatchObject({
      setup: { sessionResumption: { handle: 'resume-handle' } },
    });
    sockets[1]!.message({ setupComplete: {} });
    expect(sockets[1]!.sent).toHaveLength(1);
    await session.close();
    vi.useRealTimers();
  });

  it('waits for IDLE before committing an Extended Thinking turn', async () => {
    const { session, socket } = await setup({
      ...config,
      modelId: 'gemini-3.8-live-extended-thinking',
      thinkingLevel: 'high',
    });
    const iterator = session.events[Symbol.asyncIterator]();
    socket.message({
      serverContent: {
        outputTranscription: { text: 'working' },
        interactionStatus: 'IN_PROGRESS',
        turnComplete: true,
      },
    });
    socket.message({ serverContent: { interactionStatus: 'IDLE' } });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'assistant-transcript', text: 'working' },
    });
    await session.close();
  });
});

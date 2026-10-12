import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import type {
  ProviderInstance,
  ProviderVoicePreviewContext,
} from '../provider-registry';
import { generateVoicePreview } from './voice-preview';

class FakeSocket extends EventEmitter {
  sent: Record<string, any>[] = [];
  terminate = vi.fn();
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  message(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}
const pcm = Buffer.from([0, 128, 255, 127]);
function setup(
  type: ProviderInstance['type'] = 'openai',
  modelId = 'gpt-realtime',
  voiceId = 'cedar',
  settings: Record<string, unknown> = {
    apiKey: 'secret',
    baseUrl: 'https://example.test/v1',
  },
  context: ProviderVoicePreviewContext = {
    name: 'Ada',
    soul: 'Help plan days and keep projects moving.',
    generateIntroduction: async () =>
      "Hi, I'm Ada, your Klex bot. I'll help you plan your day and keep your projects moving.",
  },
) {
  const socket = new FakeSocket();
  const connect = vi.fn<
    (url: string, options: WebSocket.ClientOptions) => WebSocket
  >(() => socket as unknown as WebSocket);
  const controller = new AbortController();
  const result = generateVoicePreview(
    { id: 'test', type, settings },
    modelId,
    voiceId,
    controller.signal,
    context,
    connect,
  );
  return { socket, connect, controller, result };
}
function audio(socket: FakeSocket) {
  socket.message({
    type: 'response.output_audio.delta',
    delta: pcm.toString('base64'),
  });
}
afterEach(() => vi.useRealTimers());

describe('isolated voice previews', () => {
  it('configures the selected Realtime model/voice and returns PCM16 WAV without history/tools', async () => {
    const h = setup();
    expect(h.connect).toHaveBeenCalledWith(
      'wss://example.test/v1/realtime?model=gpt-realtime',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret' },
        followRedirects: false,
      }),
    );
    h.socket.emit('open');
    expect(h.socket.sent[0]).toMatchObject({
      type: 'session.update',
      session: {
        tools: [],
        instructions: expect.stringContaining('"agentName":"Ada"'),
        audio: {
          output: {
            voice: 'cedar',
            format: { type: 'audio/pcm', rate: 24000 },
          },
        },
      },
    });
    expect(h.socket.sent).toHaveLength(1);
    h.socket.message({ type: 'session.updated' });
    expect(h.socket.sent[1]).toMatchObject({ type: 'response.create' });
    audio(h.socket);
    h.socket.message({
      type: 'response.done',
      response: { status: 'completed' },
    });
    const result = await h.result;
    expect(result.ok).toBe(true);
    if (result.ok) {
      const wav = Buffer.from(result.value.audio);
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(wav.readUInt32LE(24)).toBe(24000);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.readUInt32LE(40)).toBe(pcm.length);
      expect(wav.subarray(44)).toEqual(pcm);
      expect(result.value).toMatchObject({
        mimeType: 'audio/wav',
        sourceModelId: 'gpt-realtime',
        mode: 'live',
      });
    }
    expect(h.socket.terminate).toHaveBeenCalledOnce();
    expect(h.socket.listenerCount('message')).toBe(0);
  });

  it('uses Gemini setup, waits for readiness, and collects inline PCM through turn completion', async () => {
    const h = setup(
      'google-gemini',
      'gemini-2.5-flash-native-audio-preview-12-2025',
      'Puck',
      { apiKey: 'secret' },
    );
    expect(h.connect).toHaveBeenCalledWith(
      expect.stringContaining(
        '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
      ),
      expect.objectContaining({ headers: { 'x-goog-api-key': 'secret' } }),
    );
    h.socket.emit('open');
    expect(
      h.socket.sent[0]?.setup.generationConfig.speechConfig.voiceConfig
        .prebuiltVoiceConfig.voiceName,
    ).toBe('Puck');
    expect(h.socket.sent[0]?.setup).not.toHaveProperty('tools');
    expect(h.socket.sent[0]?.setup.systemInstruction.parts[0].text).toContain(
      '"soul":"Help plan days and keep projects moving."',
    );
    expect(h.socket.sent[0]?.setup.systemInstruction.parts[0].text).toContain(
      'Improvise the wording',
    );
    h.socket.message({ setupComplete: {} });
    expect(h.socket.sent[1]?.clientContent.turnComplete).toBe(true);
    h.socket.message({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000',
                data: pcm.toString('base64'),
              },
            },
          ],
        },
        turnComplete: true,
      },
    });
    expect((await h.result).ok).toBe(true);
    expect(h.socket.terminate).toHaveBeenCalledOnce();
  });

  it('starts GPT-Live in explicit client mode, appends commentary, supplies clock, and closes after speech', async () => {
    vi.useFakeTimers();
    const h = setup('openai', 'gpt-live-1', 'quartz');
    await Promise.resolve();
    expect(h.connect.mock.calls[0]?.[0]).toBe(
      'wss://example.test/v1/live/sessions',
    );
    h.socket.emit('open');
    expect(h.socket.sent[0]).toMatchObject({
      type: 'session.start',
      session: {
        model: 'gpt-live-1',
        store: false,
        input: [],
        delegation: { type: 'client' },
        audio: { output: { voice: 'quartz' } },
      },
    });
    h.socket.message({ type: 'session.started' });
    expect(h.socket.sent[1]).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: null,
      content:
        "Hi, I'm Ada, your Klex bot. I'll help you plan your day and keep your projects moving.",
    });
    expect(h.socket.sent[2]?.type).toBe('session.input_audio.append');
    h.socket.message({
      type: 'session.output_audio.delta',
      delta: pcm.toString('base64'),
    });
    await vi.advanceTimersByTimeAsync(750);
    expect((await h.result).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores initial Live silence and completes even when trailing silent PCM frames keep arriving', async () => {
    vi.useFakeTimers();
    const h = setup('openai', 'gpt-live-1', 'meridian');
    await Promise.resolve();
    h.socket.emit('open');
    h.socket.message({ type: 'session.started' });
    const silent = {
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(960).toString('base64'),
    };
    // Initial silence can exceed the sample byte budget without using it.
    for (let index = 0; index < 650; index++) {
      h.socket.message(silent);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(h.socket.terminate).not.toHaveBeenCalled();
    h.socket.message({
      type: 'session.output_audio.delta',
      delta: pcm.toString('base64'),
    });
    for (let index = 0; index < 37; index++) {
      h.socket.message(silent);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(h.socket.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    const result = await h.result;
    expect(result.ok).toBe(true);
    if (result.ok) {
      const wav = Buffer.from(result.value.audio);
      expect(wav.subarray(44, 48)).toEqual(pcm);
      expect(wav.readUInt32LE(40)).toBe(pcm.length + 37 * 960);
    }
    expect(h.socket.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([9, 12])(
    'accepts %i seconds of completed preview audio',
    async (seconds) => {
      const h = setup();
      h.socket.emit('open');
      h.socket.message({ type: 'session.updated' });
      const chunk = Buffer.alloc(24_000 * 2 * 3, 1);
      for (let index = 0; index < seconds / 3; index++) {
        h.socket.message({
          type: 'response.output_audio.delta',
          delta: chunk.toString('base64'),
        });
      }
      h.socket.message({
        type: 'response.done',
        response: { status: 'completed' },
      });
      const result = await h.result;
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(Buffer.from(result.value.audio).readUInt32LE(40)).toBe(
          24_000 * 2 * seconds,
        );
      expect(h.socket.terminate).toHaveBeenCalledOnce();
    },
  );

  it('rejects cumulative audio beyond twelve seconds and cleans up', async () => {
    const h = setup();
    h.socket.emit('open');
    h.socket.message({ type: 'session.updated' });
    const chunk = Buffer.alloc(24_000 * 2 * 3, 1).toString('base64');
    for (let index = 0; index < 4; index++)
      h.socket.message({ type: 'response.output_audio.delta', delta: chunk });
    expect(h.socket.terminate).not.toHaveBeenCalled();
    audio(h.socket);
    expect(await h.result).toMatchObject({
      ok: false,
      code: 'preview_failed',
      message: 'Voice preview failed: Audio limit exceeded',
    });
    expect(h.socket.terminate).toHaveBeenCalledOnce();
  });

  it('accepts eleven seconds of Live speech plus the trailing silence window', async () => {
    vi.useFakeTimers();
    const h = setup('openai', 'gpt-live-1', 'meridian');
    await Promise.resolve();
    h.socket.emit('open');
    h.socket.message({ type: 'session.started' });
    h.socket.message({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(24_000 * 2 * 11, 1).toString('base64'),
    });
    for (let index = 0; index < 37; index++) {
      h.socket.message({
        type: 'session.output_audio.delta',
        delta: Buffer.alloc(960).toString('base64'),
      });
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(10);
    const result = await h.result;
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(Buffer.from(result.value.audio).readUInt32LE(40)).toBe(
        24_000 * 2 * 11 + 37 * 960,
      );
    expect(h.socket.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out Live sessions that produce only silent frames', async () => {
    vi.useFakeTimers();
    const h = setup('openai', 'gpt-live-1', 'meridian');
    await Promise.resolve();
    h.socket.emit('open');
    h.socket.message({ type: 'session.started' });
    h.socket.message({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(960).toString('base64'),
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await h.result).toMatchObject({
      ok: false,
      code: 'preview_failed',
      message: 'Voice preview timed out',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts newly discovered built-in IDs without a local catalog or another fetch', async () => {
    const h = setup('openai', 'gpt-realtime', 'future-voice');
    expect(h.connect).toHaveBeenCalledOnce();
    h.socket.emit('open');
    expect(h.socket.sent[0]).toMatchObject({
      session: { audio: { output: { voice: 'future-voice' } } },
    });
    h.controller.abort();
    expect((await h.result).ok).toBe(false);
  });

  it('rejects missing credentials, unsupported models and malformed voice IDs without opening a socket', async () => {
    for (const h of [
      setup('openai', 'gpt-realtime', 'cedar', {}),
      setup('openai', 'gpt-realtime', 'invalid voice'),
      setup('openai', 'gpt-realtime', 'voice_custom'),
      setup('openai', 'gpt-5', 'cedar'),
      setup('google-gemini', 'gemini-3.8-live', 'unknown'),
    ]) {
      expect((await h.result).ok).toBe(false);
      expect(h.connect).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed, empty, oversized, incomplete and pre-readiness audio and cleans up', async () => {
    for (const event of [
      { type: 'response.output_audio.delta', delta: '*' },
      {
        type: 'response.output_audio.delta',
        delta: Buffer.from([1]).toString('base64'),
      },
      {
        type: 'response.output_audio.delta',
        delta: Buffer.alloc(576002).toString('base64'),
      },
      { type: 'response.done', response: { status: 'completed' } },
      { type: 'response.done', response: { status: 'failed' } },
      { type: 'response.function_call_arguments.done' },
    ]) {
      const h = setup();
      h.socket.emit('open');
      h.socket.message({ type: 'session.updated' });
      h.socket.message(event);
      expect(await h.result).toMatchObject({
        ok: false,
        code: 'preview_failed',
      });
      expect(h.socket.terminate).toHaveBeenCalledOnce();
    }
    const h = setup();
    audio(h.socket);
    expect((await h.result).ok).toBe(false);
  });

  it('fails on cancellation, premature closure, malformed JSON and provider errors without leaking upstream text', async () => {
    for (const fail of [
      (h: ReturnType<typeof setup>) => h.controller.abort(),
      (h: ReturnType<typeof setup>) => h.socket.emit('close'),
      (h: ReturnType<typeof setup>) =>
        h.socket.emit('message', Buffer.from('{')),
      (h: ReturnType<typeof setup>) =>
        h.socket.message({ type: 'error', error: { message: 'secret' } }),
    ]) {
      const h = setup();
      fail(h);
      expect(await h.result).toMatchObject({
        ok: false,
        code: 'preview_failed',
      });
      expect(JSON.stringify(await h.result)).not.toContain('secret');
      expect(h.socket.terminate).toHaveBeenCalledOnce();
    }
  });

  it.each(['rate_limit_exceeded', 'insufficient_quota'])(
    'classifies post-handshake %s as rate_limited without leaking upstream text',
    async (code) => {
      for (const modelId of ['gpt-live-1', 'gpt-realtime']) {
        const h = setup('openai', modelId, 'marin');
        await Promise.resolve();
        h.socket.emit('open');
        h.socket.message({ type: 'error', error: { code, message: 'secret' } });
        expect(await h.result).toMatchObject({
          ok: false,
          code: 'rate_limited',
        });
        expect(JSON.stringify(await h.result)).not.toContain('secret');
        expect(h.socket.terminate).toHaveBeenCalledOnce();
        expect(h.socket.listenerCount('message')).toBe(0);
      }
    },
  );

  it('uses the Live endpoint and exact dated model for snapshots', async () => {
    const h = setup('openai', 'gpt-live-1-2026-10-01', 'marin');
    await Promise.resolve();
    expect(h.connect.mock.calls[0]?.[0]).toBe(
      'wss://example.test/v1/live/sessions',
    );
    h.socket.emit('open');
    expect(h.socket.sent[0]).toMatchObject({
      type: 'session.start',
      session: { model: 'gpt-live-1-2026-10-01' },
    });
    h.controller.abort();
    expect((await h.result).ok).toBe(false);
  });

  it('reports known provider error codes and parameters without exposing arbitrary upstream text', async () => {
    const h = setup('openai', 'gpt-live-1', 'meridian');
    await Promise.resolve();
    h.socket.message({
      type: 'error',
      error: {
        code: 'invalid_type',
        param: 'session.delegation',
        message: 'secret upstream response',
      },
    });
    expect(await h.result).toMatchObject({
      ok: false,
      code: 'preview_failed',
      message:
        'Provider rejected the voice preview request: invalid_type, session.delegation',
    });
    expect(JSON.stringify(await h.result)).not.toContain('secret');
    const unknown = setup();
    unknown.socket.message({
      type: 'error',
      error: { code: 'secret', param: 'secret', message: 'secret' },
    });
    expect(JSON.stringify(await unknown.result)).not.toContain('secret');
  });

  it('distinguishes socket errors and premature closure without exposing socket error text', async () => {
    const error = setup();
    error.socket.emit('error', new Error('secret'));
    expect(await error.result).toMatchObject({
      ok: false,
      message: 'Voice preview connection failed',
    });
    const closed = setup();
    closed.socket.emit('close', 1008, Buffer.from('secret'));
    expect(await closed.result).toMatchObject({
      ok: false,
      message: 'Voice preview connection closed before completion',
    });
  });

  it('requires a chat generator for Live and never falls back to the fixed sample', async () => {
    const h = setup(
      'openai',
      'gpt-live-1',
      'meridian',
      { apiKey: 'secret' },
      { name: 'Ada', soul: null },
    );
    expect(await h.result).toMatchObject({
      ok: false,
      code: 'invalid_configuration',
    });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('rejects invalid or failed introductions before opening Live sockets without leaking text', async () => {
    for (const generateIntroduction of [
      async () => '',
      async () => Array(21).fill('word').join(' '),
      async () => {
        throw new Error('private soul or credentials');
      },
    ]) {
      const h = setup(
        'openai',
        'gpt-live-1',
        'meridian',
        { apiKey: 'secret' },
        { name: 'Ada', soul: null, generateIntroduction },
      );
      expect(await h.result).toMatchObject({
        ok: false,
        code: 'preview_failed',
      });
      expect(JSON.stringify(await h.result)).not.toContain('private soul');
      expect(h.connect).not.toHaveBeenCalled();
    }
  });

  it('passes context and cancellation to Live text generation and never connects after cancellation', async () => {
    let complete!: (text: string) => void;
    const generateIntroduction = vi.fn(
      (_instructions: string, _signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const h = setup(
      'openai',
      'gpt-live-1',
      'meridian',
      { apiKey: 'secret' },
      { name: 'Ada', soul: 'Help plan projects.', generateIntroduction },
    );
    expect(generateIntroduction).toHaveBeenCalledWith(
      expect.stringContaining('"soul":"Help plan projects."'),
      h.controller.signal,
    );
    h.controller.abort();
    complete("Hi, I'm Ada, your Klex bot.");
    expect(await h.result).toMatchObject({
      ok: false,
      message: 'Voice preview cancelled',
    });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('does not request text generation for Realtime or Gemini', async () => {
    const generateIntroduction = vi.fn(async () => 'Unused');
    for (const [type, modelId, voiceId] of [
      ['openai', 'gpt-realtime', 'cedar'],
      ['google-gemini', 'gemini-3.8-live', 'Puck'],
    ] as const) {
      const h = setup(
        type,
        modelId,
        voiceId,
        { apiKey: 'secret' },
        { name: 'Ada', soul: null, generateIntroduction },
      );
      h.controller.abort();
      await h.result;
    }
    expect(generateIntroduction).not.toHaveBeenCalled();
  });

  it('times out silent providers and stops all timers', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.socket.emit('open');
    await vi.advanceTimersByTimeAsync(30000);
    expect(await h.result).toMatchObject({ ok: false, code: 'preview_failed' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

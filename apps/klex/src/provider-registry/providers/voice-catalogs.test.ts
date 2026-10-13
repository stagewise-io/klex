import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVoiceOperations } from '../voice-operations';
import {
  discoverGeminiVoices,
  discoverOpenAiVoices,
  isGeminiVoiceModel,
} from './voice-catalogs';

const model = 'gemini-2.5-flash-native-audio-preview-12-2025';
const instance = {
  id: 'google',
  type: 'google-gemini' as const,
  settings: { apiKey: 'secret' },
};
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

const schema = (
  liveVoice: unknown = {
    oneOf: [
      {
        anyOf: [
          { type: 'string' },
          { enum: ['future-live', 'marin', 'future-live'] },
        ],
      },
      { $ref: '#/components/schemas/CustomVoice' },
    ],
  },
) => ({
  openapi: '3.1.0',
  components: {
    schemas: {
      VoiceIdsShared: {
        anyOf: [{ type: 'string' }, { enum: ['future-realtime', 'marin'] }],
      },
      LiveInitialSessionAudioOutputParam: { properties: { voice: liveVoice } },
      CustomVoice: {
        type: 'object',
        properties: { id: { enum: ['voice_private'] } },
      },
    },
  },
});

function serveSchema(body: unknown = schema()) {
  const fetcher = vi.fn().mockImplementation(async () => Response.json(body));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('OpenAI schema voice discovery', () => {
  it('extracts distinct family enums, discovers new IDs, deduplicates and ignores custom IDs', async () => {
    const fetcher = serveSchema();
    const live = await discoverOpenAiVoices('gpt-live-1-2026-10-01', signal());
    expect(live).toMatchObject({
      ok: true,
      value: { defaultVoiceId: 'marin' },
    });
    if (live.ok) {
      expect(live.value.voices.map((item) => item.voiceId)).toEqual([
        'future-live',
        'marin',
      ]);
      expect(live.value.voices[0]).toEqual({
        voiceId: 'future-live',
        displayName: 'future-live',
        isPreviewAvailable: true,
      });
    }
    const realtime = await discoverOpenAiVoices('gpt-realtime-2.1', signal());
    expect(realtime.ok).toBe(true);
    if (realtime.ok)
      expect(realtime.value.voices.map((item) => item.voiceId)).toEqual([
        'future-realtime',
        'marin',
      ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml',
      { signal: expect.any(AbortSignal), redirect: 'error' },
    );
  });

  it('parses YAML with local references and composition without fabricating a default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(`openapi: 3.1.0
components:
  schemas:
    LiveInitialSessionAudioOutputParam:
      properties:
        voice:
          $ref: '#/components/schemas/LiveVoices'
    LiveVoices:
      allOf:
        - anyOf:
            - type: string
            - enum: [new-voice]
`),
      ),
    );
    const live = await discoverOpenAiVoices('gpt-live-1', signal());
    expect(live).toMatchObject({
      ok: true,
      value: { voices: [{ voiceId: 'new-voice' }] },
    });
    if (live.ok) expect(live.value.defaultVoiceId).toBeUndefined();
    const result = await discoverOpenAiVoices(
      'gpt-4o-realtime-preview',
      signal(),
    );
    expect(result).toMatchObject({ ok: false, code: 'discovery_failed' });
  });

  it('does not fetch for unrelated/custom models or already cancelled requests', async () => {
    const fetcher = serveSchema();
    for (const id of [
      'gpt-live-transcribe',
      'gpt-realtime-whisper',
      'gpt-realtime-translate',
      'custom',
      'gpt-5',
    ])
      expect(await discoverOpenAiVoices(id, signal())).toMatchObject({
        ok: true,
        value: { voices: [] },
      });
    expect(
      await discoverOpenAiVoices('gpt-live-1', AbortSignal.abort()),
    ).toMatchObject({ ok: false, code: 'discovery_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { type: 'string' },
    { enum: [] },
    { enum: ['voice_custom'] },
    { enum: ['invalid voice'] },
    { enum: [123] },
    { enum: Array.from({ length: 257 }, (_, i) => `voice-${i}`) },
    { $ref: '#/components/schemas/Missing' },
    { $ref: 'https://example.test/schema' },
    {
      $ref: '#/components/schemas/LiveInitialSessionAudioOutputParam',
      anyOf: [
        { $ref: '#/components/schemas/LiveInitialSessionAudioOutputParam' },
      ],
    },
    { anyOf: 'invalid' },
  ])(
    'fails discovery for invalid or absent voice schemas: %j',
    async (root) => {
      serveSchema(schema(root));
      // Undefined must mean an absent property, not the fixture's default.
      if (root === undefined)
        serveSchema({ openapi: '3.1.0', components: { schemas: {} } });
      expect(await discoverOpenAiVoices('gpt-live-1', signal())).toMatchObject({
        ok: false,
        code: 'discovery_failed',
      });
    },
  );

  it('rejects cyclic schema references', async () => {
    const body = schema({ $ref: '#/components/schemas/Cycle' });
    serveSchema({
      ...body,
      components: {
        schemas: {
          ...body.components.schemas,
          Cycle: { $ref: '#/components/schemas/Cycle' },
        },
      },
    });
    expect(await discoverOpenAiVoices('gpt-live-1', signal())).toMatchObject({
      ok: false,
      code: 'discovery_failed',
    });
  });

  it('rejects malformed YAML, aliases, duplicate keys, missing schemas and oversized responses', async () => {
    for (const response of [
      new Response('openapi: [broken'),
      new Response('openapi: 3.1.0\nopenapi: 3.0.0'),
      new Response('openapi: 3.1.0\ncomponents: &a {schemas: {}}\ncopy: *a'),
      Response.json({ openapi: '2.0', components: { schemas: {} } }),
      Response.json({ openapi: '3.1.0' }),
      new Response('', {
        headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
      }),
      new Response(' '.repeat(8 * 1024 * 1024 + 1)),
      new Response(null, { status: 503 }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      expect(await discoverOpenAiVoices('gpt-live-1', signal())).toMatchObject({
        ok: false,
        code: 'discovery_failed',
      });
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network unavailable')),
    );
    expect(await discoverOpenAiVoices('gpt-live-1', signal())).toMatchObject({
      ok: false,
      code: 'discovery_failed',
    });
  });

  it('reuses registry caching, refreshes changed IDs and preserves the last good catalog on failure', async () => {
    const fetcher = serveSchema();
    const operations = createVoiceOperations();
    const hook = (abort: AbortSignal) =>
      discoverOpenAiVoices('gpt-live-1', abort);
    try {
      const first = await operations.list('p', 's', 'gpt-live-1', false, hook);
      expect(first.ok).toBe(true);
      expect(
        await operations.list('p', 's', 'gpt-live-1', false, hook),
      ).toEqual(first);
      expect(fetcher).toHaveBeenCalledTimes(1);
      fetcher.mockImplementation(async () =>
        Response.json(schema({ enum: ['brand-new'] })),
      );
      expect(
        await operations.list('p', 's', 'gpt-live-1', true, hook),
      ).toMatchObject({
        ok: true,
        value: { voices: [{ voiceId: 'brand-new' }] },
      });
      fetcher.mockRejectedValue(new Error('offline'));
      expect(
        await operations.list('p', 's', 'gpt-live-1', true, hook),
      ).toMatchObject({
        ok: true,
        value: { stale: true, voices: [{ voiceId: 'brand-new' }] },
      });
      expect(
        await operations.list('cold', 's', 'gpt-live-1', true, hook),
      ).toMatchObject({ ok: false, code: 'discovery_failed' });
    } finally {
      operations.close();
    }
  });
});

describe('Gemini voice catalogs', () => {
  it('excludes unrelated Gemini models and retains provider defaults', () => {
    expect(isGeminiVoiceModel(`models/${model}`)).toBe(true);
    expect(isGeminiVoiceModel('gemini-custom-live')).toBe(false);
  });

  it('discovers new prebuilt IDs, paginates metadata, deduplicates and excludes custom voices', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          voices: [
            {
              id: 'Puck',
              type: 'prebuilt',
              display_name: 'Puck voice',
              persona: 'Upbeat',
              language_code: 'en-US',
            },
            { id: 'voice_secret', type: 'prompted' },
            { id: 'Unknown', type: 'prebuilt' },
          ],
          next_page_token: 'next',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          voices: [
            { id: 'Charon', type: 'prebuilt', region_code: 'US' },
            {
              id: 'Unknown',
              type: 'prebuilt',
              description: 'New catalog voice',
            },
            { id: 'voice_private', type: 'replicated' },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    const result = await discoverGeminiVoices(instance, model, signal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.value.voices.find((item) => item.voiceId === 'Puck'),
      ).toEqual({
        voiceId: 'Puck',
        displayName: 'Puck voice',
        description: 'Upbeat',
        isPreviewAvailable: true,
      });
      expect(result.value.voices.map((item) => item.voiceId)).not.toContain(
        'voice_secret',
      );
      expect(result.value.voices.map((item) => item.voiceId)).toEqual([
        'Puck',
        'Unknown',
        'Charon',
      ]);
      expect(result.value.voices[1]).toEqual({
        voiceId: 'Unknown',
        displayName: 'Unknown',
        description: 'New catalog voice',
        isPreviewAvailable: true,
      });
      expect(result.value.voices[2]).toEqual({
        voiceId: 'Charon',
        displayName: 'Charon',
        isPreviewAvailable: true,
      });
      expect(Object.keys(result.value)).toEqual(['voices']);
      expect(result.value.defaultVoiceId).toBeUndefined();
    }
    expect(fetcher.mock.calls[1]?.[0].searchParams.get('page_token')).toBe(
      'next',
    );
    expect(fetcher.mock.calls[0]?.[1].headers['x-goog-api-key']).toBe('secret');
    expect(fetcher.mock.calls[0]?.[0].searchParams.get('type')).toBe(
      'prebuilt',
    );
    expect(fetcher.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('returns discovery errors rather than fixed fallback voices and preserves authentication errors', async () => {
    for (const status of [404, 405, 501, 503]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(null, { status })),
      );
      expect(
        await discoverGeminiVoices(instance, model, signal()),
      ).toMatchObject({ ok: false, code: 'discovery_failed' });
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await discoverGeminiVoices(instance, model, signal())).toMatchObject(
      { ok: false, code: 'discovery_failed' },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
    );
    expect(await discoverGeminiVoices(instance, model, signal())).toMatchObject(
      { ok: false, code: 'authentication_required' },
    );
    expect(
      await discoverGeminiVoices(
        { ...instance, settings: {} },
        model,
        signal(),
      ),
    ).toMatchObject({ ok: false, code: 'authentication_required' });
  });

  it.each([
    {},
    { voices: [] },
    { voices: [null] },
    { voices: [{ id: 'voice_custom', type: 'prebuilt' }] },
    { voices: [{ id: 'voicekey_custom', type: 'prebuilt' }] },
    { voices: [{ id: 'bad voice', type: 'prebuilt' }] },
    { voices: [{ id: 42, type: 'prebuilt' }] },
    { voices: [{ id: 'voice_private', type: 'prompted' }] },
    { voices: [{ id: 'Puck', type: 'prebuilt' }], next_page_token: 42 },
  ])('rejects empty or malformed catalogs: %j', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => Response.json(body)),
    );
    expect(await discoverGeminiVoices(instance, model, signal())).toMatchObject(
      { ok: false, code: 'discovery_failed' },
    );
  });

  it('uses registry caching, refreshes changed IDs and preserves only the last good catalog on failure', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ voices: [{ id: 'NewVoice', type: 'prebuilt' }] }),
      );
    vi.stubGlobal('fetch', fetcher);
    const operations = createVoiceOperations();
    const hook = (abort: AbortSignal) =>
      discoverGeminiVoices(instance, model, abort);
    try {
      const first = await operations.list('p', 's', model, false, hook);
      expect(first).toMatchObject({
        ok: true,
        value: { voices: [{ voiceId: 'NewVoice' }] },
      });
      expect(await operations.list('p', 's', model, false, hook)).toEqual(
        first,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      fetcher.mockImplementation(async () =>
        Response.json({ voices: [{ id: 'NextVoice', type: 'prebuilt' }] }),
      );
      expect(await operations.list('p', 's', model, true, hook)).toMatchObject({
        ok: true,
        value: { voices: [{ voiceId: 'NextVoice' }] },
      });
      fetcher.mockRejectedValue(new Error('offline'));
      expect(await operations.list('p', 's', model, true, hook)).toMatchObject({
        ok: true,
        value: { stale: true, voices: [{ voiceId: 'NextVoice' }] },
      });
      expect(
        await operations.list('cold', 's', model, true, hook),
      ).toMatchObject({ ok: false, code: 'discovery_failed' });
      fetcher.mockImplementation(
        async () => new Response(null, { status: 403 }),
      );
      expect(await operations.list('p', 's', model, true, hook)).toMatchObject({
        ok: false,
        code: 'authentication_required',
      });
    } finally {
      operations.close();
    }
  });

  it('skips fetch when cancelled and cancels error response bodies', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(
      await discoverGeminiVoices(instance, model, AbortSignal.abort()),
    ).toMatchObject({ ok: false, code: 'discovery_failed' });
    expect(fetcher).not.toHaveBeenCalled();
    const cancel = vi.fn();
    fetcher.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), { status: 403 }),
    );
    expect(await discoverGeminiVoices(instance, model, signal())).toMatchObject(
      { ok: false, code: 'authentication_required' },
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds pagination and catalog size and never returns a partially fetched catalog', async () => {
    let page = 0;
    const fetcher = vi.fn().mockImplementation(async () =>
      Response.json({
        voices: [{ id: 'Puck', type: 'prebuilt' }],
        next_page_token: `page-${++page}`,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await discoverGeminiVoices(instance, model, signal())).toMatchObject(
      { ok: false, code: 'discovery_failed' },
    );
    expect(fetcher).toHaveBeenCalledTimes(100);
    fetcher.mockImplementation(async () =>
      Response.json({
        voices: Array.from({ length: 10_001 }, (_, i) => ({
          id: `NewVoice-${i}`,
          type: 'prebuilt',
        })),
      }),
    );
    expect(await discoverGeminiVoices(instance, model, signal())).toMatchObject(
      { ok: false, code: 'discovery_failed' },
    );
    fetcher
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({
          voices: [{ id: 'Puck', type: 'prebuilt' }],
          next_page_token: 'next',
        }),
      )
      .mockRejectedValueOnce(new Error('offline'));
    expect(await discoverGeminiVoices(instance, model, signal())).toMatchObject(
      { ok: false, code: 'discovery_failed' },
    );
  });

  it('rejects oversized Gemini bodies with or without Content-Length and cancels the stream', async () => {
    for (const headers of [
      { 'content-length': String(8 * 1024 * 1024 + 1) },
      {},
    ]) {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
          },
          cancel,
        }),
        { headers },
      );
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      expect(
        await discoverGeminiVoices(instance, model, signal()),
      ).toMatchObject({
        ok: false,
        code: 'discovery_failed',
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    }
  });

  it('rejects malformed/repeated pagination and skips network for unsupported profiles', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ voices: 'bad' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await discoverGeminiVoices(instance, model, signal())).toMatchObject(
      { ok: false, code: 'discovery_failed' },
    );
    fetcher.mockImplementation(async () =>
      Response.json({ voices: [], next_page_token: 'same' }),
    );
    expect(await discoverGeminiVoices(instance, model, signal())).toMatchObject(
      { ok: false, code: 'discovery_failed' },
    );
    fetcher.mockClear();
    expect(
      await discoverGeminiVoices(instance, 'custom/live', signal()),
    ).toMatchObject({ ok: true, value: { voices: [] } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

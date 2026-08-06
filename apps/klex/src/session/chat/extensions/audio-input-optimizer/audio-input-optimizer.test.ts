import type { ModelMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAudioInputOptimizerCache,
  createAudioInputOptimizerExt,
  getContent,
  makeDeps,
  makeFilePart,
  makeModel,
  makeUserMessage,
  makeWavBuffer,
  runTransformer,
} from './test-helpers';

vi.mock('ffmpeg-static', () => ({
  default: '/mock/ffmpeg',
}));

vi.mock('ffprobe-static', () => ({
  path: '/mock/ffprobe',
}));

vi.mock('fluent-ffmpeg', () => {
  function createCommand(input: any) {
    return {
      toFormat() {
        return this;
      },
      audioBitrate() {
        return this;
      },
      audioFrequency() {
        return this;
      },
      audioChannels() {
        return this;
      },
      on(_event: string, _handler: (err: Error) => void) {
        return this;
      },
      pipe(dest: any) {
        input.destroy();
        dest.write(Buffer.alloc(100, 0));
        dest.end();
        return dest;
      },
      ffprobe(callback: (err: Error | null) => void) {
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        const bytes: number[] = [];
        input.on('data', (chunk: any) => {
          if (typeof chunk === 'number') {
            bytes.push(chunk);
          } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
            for (const b of chunk) bytes.push(b);
          } else {
            bytes.push(Number(chunk));
          }
          if (bytes.length >= 4) {
            input.destroy();
            const header = String.fromCharCode(...bytes.slice(0, 4));
            settle(() =>
              callback(
                header === 'RIFF' ? null : new Error('Invalid audio data'),
              ),
            );
          }
        });
        input.on('end', () => {
          settle(() => {
            if (bytes.length < 4) {
              callback(new Error('Invalid audio data'));
            }
          });
        });
        input.on('error', (err: Error) => settle(() => callback(err)));
      },
      kill() {},
    };
  }

  const ffmpeg: any = (input: any) => createCommand(input);
  ffmpeg.setFfmpegPath = () => {};
  ffmpeg.setFfprobePath = () => {};

  return { default: ffmpeg };
});

vi.mock('./audio-system-prompt.md', () => ({
  default: 'Describe this audio.',
}));

vi.mock('./audio-tool-system-prompt.md', () => ({
  default: 'Answer the question about the audio.',
}));

beforeEach(() => {
  vi.clearAllMocks();
  clearAudioInputOptimizerCache();
});

describe('AudioInputOptimizer — audio detection', () => {
  it('detects FilePart with audio/wav mediaType', async () => {
    const audio = makeWavBuffer(100);
    const msg = makeUserMessage([
      { type: 'text', text: 'hello' },
      makeFilePart(audio, 'audio/wav'),
    ]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('text');
    expect(content[1]?.type).toBe('file');
  });

  it('detects FilePart with bare audio mediaType', async () => {
    const audio = makeWavBuffer(100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('file');
  });

  it('leaves non-audio FilePart untouched', async () => {
    const msg = makeUserMessage([
      makeFilePart(Buffer.from('not-audio'), 'application/pdf'),
    ]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('file');
    expect(content[0]?.mediaType).toBe('application/pdf');
  });

  it('leaves TextPart untouched', async () => {
    const msg = makeUserMessage([{ type: 'text', text: 'hello' }]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe('hello');
  });
});

describe('AudioInputOptimizer — URL audio skipped', () => {
  it('passes FilePart with URL data unchanged', async () => {
    const part: ModelMessage = {
      role: 'user',
      content: [
        {
          type: 'file',
          data: { type: 'url', url: new URL('https://example.com/audio.wav') },
          mediaType: 'audio/wav',
        },
      ],
    };
    const content = getContent(await runTransformer([part], makeModel()), 0);
    expect(content[0]).toEqual({
      type: 'file',
      data: { type: 'url', url: new URL('https://example.com/audio.wav') },
      mediaType: 'audio/wav',
    });
  });

  it('passes FilePart with bare remote URL unchanged', async () => {
    const url = new URL('https://example.com/audio.wav');
    const part: ModelMessage = {
      role: 'user',
      content: [{ type: 'file' as const, data: url, mediaType: 'audio/wav' }],
    };
    const content = getContent(await runTransformer([part], makeModel()), 0);
    expect(content[0]).toEqual({
      type: 'file',
      data: url,
      mediaType: 'audio/wav',
    });
  });

  it('processes FilePart with data URL (inline base64)', async () => {
    const audio = makeWavBuffer(100, 8000);
    const dataUrl = new URL(
      `data:audio/wav;base64,${audio.toString('base64')}`,
    );
    const part: ModelMessage = {
      role: 'user',
      content: [
        {
          type: 'file',
          data: { type: 'url', url: dataUrl },
          mediaType: 'audio/wav',
        },
      ],
    };
    const content = getContent(await runTransformer([part], makeModel()), 0);
    // Should be processed — wav is supported, within size limits → normalized to FilePart
    expect(content[0]?.type).toBe('file');
    const filePart = content[0] as {
      type: string;
      data: { type: string; data: string };
    };
    expect(filePart.data.type).toBe('data');
    expect(typeof filePart.data.data).toBe('string');
  });
});

describe('AudioInputOptimizer — no transformation needed', () => {
  it('returns audio as-is when within all limits', async () => {
    const audio = makeWavBuffer(100, 8000);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('file');
    const part = content[0] as {
      type: string;
      data: { type: string; data: string };
    };
    expect(part.data.type).toBe('data');
    expect(typeof part.data.data).toBe('string');
    // Verify it's valid base64 by decoding round-trip
    expect(Buffer.from(part.data.data, 'base64').length).toBeGreaterThan(0);
  });
});

describe('AudioInputOptimizer — format conversion', () => {
  it('converts wav to mp3 when wav is not supported', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            audio: {
              mediaTypes: ['audio/mpeg'],
              maxBytes: 25_165_824,
            },
          },
        }),
      ),
      0,
    );
    expect(content[0]?.type).toBe('file');
    expect(content[0]?.mediaType).toBe('audio/mpeg');
  });

  it('preserves dimensions/content — no resize logic for audio', async () => {
    // Audio has no dimension concept; conversion preserves duration
    const audio = makeWavBuffer(100, 8000);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            audio: {
              mediaTypes: ['audio/mpeg'],
              maxBytes: 25_165_824,
            },
          },
        }),
      ),
      0,
    );
    expect(content[0]?.mediaType).toBe('audio/mpeg');
    const part = content[0] as { data: { data: string } };
    expect(Buffer.from(part.data.data, 'base64').length).toBeGreaterThan(0);
  });
});

describe('AudioInputOptimizer — format preference', () => {
  it('prefers mp3 when mp3 is in mediaTypes', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            audio: {
              mediaTypes: ['audio/mpeg', 'audio/ogg'],
              maxBytes: 25_165_824,
            },
          },
        }),
      ),
      0,
    );
    // wav not in supportedMediaTypes → converts; mp3 preferred over ogg
    expect(content[0]?.mediaType).toBe('audio/mpeg');
  });

  it('converts to first supported format from mediaTypes', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            audio: {
              mediaTypes: ['audio/ogg', 'audio/flac'],
              maxBytes: 25_165_824,
            },
          },
        }),
      ),
      0,
    );
    // mp3 not supported, wav not supported, ogg supported → ogg
    expect(content[0]?.mediaType).toBe('audio/ogg');
  });
});

describe('AudioInputOptimizer — maxDataSize enforcement', () => {
  it('re-encodes audio until under maxBytes', async () => {
    // 1 second of 44100 Hz stereo PCM = ~176KB raw WAV
    const audio = makeWavBuffer(1000, 44100, 2);
    expect(audio.length).toBeGreaterThan(10_000);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            audio: {
              mediaTypes: ['audio/mpeg'],
              maxBytes: 10_000,
            },
          },
        }),
      ),
      0,
    );
    expect(content[0]?.type).toBe('file');
    expect(content[0]?.mediaType).toBe('audio/mpeg');
    const part = content[0] as { data: { data: string } };
    expect(Buffer.from(part.data.data, 'base64').length).toBeLessThanOrEqual(
      10_000,
    );
  });
});

describe('AudioInputOptimizer — caching', () => {
  it('returns cached result on second call with same audio + modelId', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const model = makeModel({
      inputCapabilities: {
        audio: { mediaTypes: ['audio/mpeg'], maxBytes: 25_165_824 },
      },
    });

    const result1 = await runTransformer([msg], model);
    const result2 = await runTransformer([msg], model);
    const c1 = getContent(result1, 0);
    const c2 = getContent(result2, 0);

    // Same object from cache
    expect(c1[0]).toBe(c2[0]);
  });

  it('shares cache across extension instances', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const model = makeModel({
      inputCapabilities: {
        audio: { mediaTypes: ['audio/mpeg'], maxBytes: 25_165_824 },
      },
    });

    const deps = makeDeps();
    const ext1 = createAudioInputOptimizerExt.create(deps);
    const ext2 = createAudioInputOptimizerExt.create(deps);

    const r1 = await ext1.contextTransformer?.([msg], model);
    const r2 = await ext2.contextTransformer?.([msg], model);
    const arr1 = Array.isArray(r1)
      ? r1
      : (r1 as { history: ModelMessage[] }).history;
    const arr2 = Array.isArray(r2)
      ? r2
      : (r2 as { history: ModelMessage[] }).history;
    const c1 = (arr1[0] as ModelMessage).content as unknown as Array<
      Record<string, unknown>
    >;
    const c2 = (arr2[0] as ModelMessage).content as unknown as Array<
      Record<string, unknown>
    >;

    expect(c1[0]).toBe(c2[0]);
  });

  it('uses different cache entries for different modelIds', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);

    const model1 = makeModel({ modelId: 'test:model-a' });
    const model2 = makeModel({
      modelId: 'test:model-b',
      inputCapabilities: {
        audio: { mediaTypes: ['audio/wav'], maxBytes: 25_165_824 },
      },
    });

    const result1 = await runTransformer([msg], model1);
    const result2 = await runTransformer([msg], model2);
    const c1 = getContent(result1, 0);
    const c2 = getContent(result2, 0);

    expect(c1[0]).not.toBe(c2[0]);
  });
});

describe('AudioInputOptimizer — multiple audio parts and messages', () => {
  it('processes multiple audio parts in one message independently', async () => {
    const audio1 = makeWavBuffer(200, 44100);
    const audio2 = makeWavBuffer(200, 8000);
    const msg = makeUserMessage([
      makeFilePart(audio1, 'audio/wav'),
      { type: 'text', text: 'between' },
      makeFilePart(audio2, 'audio/wav'),
    ]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            audio: {
              mediaTypes: ['audio/mpeg'],
              maxBytes: 25_165_824,
            },
          },
        }),
      ),
      0,
    );
    expect(content).toHaveLength(3);
    expect(content[0]?.type).toBe('file');
    expect(content[1]?.type).toBe('text');
    expect(content[2]?.type).toBe('file');
  });

  it('processes audio across multiple messages', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg1 = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const msg2 = makeUserMessage([
      { type: 'text', text: 'second' },
      makeFilePart(audio, 'audio/wav'),
    ]);
    const result = await runTransformer(
      [msg1, msg2],
      makeModel({
        inputCapabilities: {
          audio: { mediaTypes: ['audio/mpeg'], maxBytes: 25_165_824 },
        },
      }),
    );
    expect(result).toHaveLength(2);
    const c1 = getContent(result, 0);
    const c2 = getContent(result, 1);
    expect(c1[0]?.type).toBe('file');
    expect(c2[0]?.type).toBe('text');
    expect(c2[1]?.type).toBe('file');
  });
});

describe('AudioInputOptimizer — graceful degradation on unparseable audio', () => {
  it('replaces corrupt audio with text notification on ffmpeg error', async () => {
    const corruptBuffer = Buffer.from('not-a-real-audio-just-bytes');
    const msg = makeUserMessage([makeFilePart(corruptBuffer, 'audio/wav')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "Can't hear this audio. Audio input isn't supported.",
    );
  });
});

describe('AudioInputOptimizer — defaults', () => {
  it('passes through audio within default limits without conversion', async () => {
    const audio = makeWavBuffer(100, 8000);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('file');
    const part = content[0] as { data: { data: string } };
    expect(Buffer.from(part.data.data, 'base64')).toEqual(audio);
  });
});

describe('AudioInputOptimizer — introspection', () => {
  it('reports cache size via introspect()', async () => {
    const ext = createAudioInputOptimizerExt.create(makeDeps());
    expect(ext.introspect?.()).toEqual({
      cacheSize: 0,
      descriptionCacheSize: 0,
      registeredAudio: 0,
    });

    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    await ext.contextTransformer?.(
      [msg],
      makeModel({
        inputCapabilities: {
          audio: { mediaTypes: ['audio/mpeg'], maxBytes: 25_165_824 },
        },
      }),
    );

    expect(ext.introspect?.()).toEqual({
      cacheSize: 1,
      descriptionCacheSize: 0,
      registeredAudio: 0,
    });
  });
});

describe('AudioInputOptimizer — non-audio content preserved', () => {
  it('does not modify text parts or non-audio file parts', async () => {
    const textPart = { type: 'text' as const, text: 'hello' };
    const pdfPart = {
      type: 'file' as const,
      data: { type: 'data' as const, data: Buffer.from('pdf-data') },
      mediaType: 'application/pdf',
    };
    const msg = makeUserMessage([textPart, pdfPart]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]).toEqual(textPart);
    expect(content[1]).toEqual(pdfPart);
  });
});

describe('AudioInputOptimizer — supports: false (no audio models)', () => {
  it('replaces audio with TextPart notification when no audio models configured', async () => {
    const audio = makeWavBuffer(100, 8000);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} })),
      0,
    );
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "Can't hear this audio. Audio input isn't supported.",
    );
  });

  it('caches the TextPart replacement', async () => {
    const audio = makeWavBuffer(100, 8000);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const model = makeModel({ inputCapabilities: {} });
    const result1 = await runTransformer([msg], model);
    const result2 = await runTransformer([msg], model);
    const c1 = getContent(result1, 0);
    const c2 = getContent(result2, 0);
    expect(c1[0]?.text).toBe(c2[0]?.text);
  });
});

import type { FilePart, ModelMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionDeps } from '../extension-api';
import {
  clearAudioInputOptimizerCache,
  createAudioInputOptimizerExt,
  DEFAULT_AUDIO_CAPS,
  genFailure,
  genSuccess,
  getContent,
  makeAudioConfig,
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

// Production code calls existsSync on the ffmpeg/ffprobe paths and throws
// if missing. Mock it to return true for those mock paths.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (p === '/mock/ffmpeg' || p === '/mock/ffprobe') return true;
      return actual.existsSync(p);
    }),
  };
});

vi.mock('fluent-ffmpeg', () => {
  function parseWavDuration(bytes: number[]): number {
    if (bytes.length < 44) return 0;
    const buf = Buffer.from(bytes);
    if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') return 0;
    const sampleRate = buf.readUInt32LE(24);
    const channels = buf.readUInt16LE(22);
    const dataSize = buf.readUInt32LE(40);
    const byteRate = sampleRate * channels * 2;
    return byteRate > 0 ? dataSize / byteRate : 0;
  }

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
      duration() {
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
      ffprobe(callback: (err: Error | null, data?: any) => void) {
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
          if (bytes.length >= 44) {
            input.destroy();
            const header = String.fromCharCode(...bytes.slice(0, 4));
            if (header !== 'RIFF') {
              settle(() => callback(new Error('Invalid audio data')));
              return;
            }
            const duration = parseWavDuration(bytes);
            settle(() =>
              callback(null, {
                format: { duration },
                streams: [{ duration }],
              }),
            );
          }
        });
        input.on('end', () => {
          settle(() => {
            if (bytes.length < 44) {
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

describe('AudioInputOptimizer — supports: false with audio models', () => {
  it('replaces audio with description + listenAudio hint when audio models configured', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "A 440 Hz sine wave tone.\n\nFor more specific details about this audio, use the 'listenAudio' tool with ID 0-0.",
    );
  });

  it('falls back to placeholder when audio model fails to describe', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi.fn().mockResolvedValue(genFailure());
    const deps = makeDeps({ config, generateText });
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "Can't directly hear audio. Use tool 'listenAudio' with ID 0-0 to get information on audio content.",
    );
  });

  it('uses messageIndex-partIndex as audio ID for multiple audio clips', async () => {
    const audio1 = makeWavBuffer(200, 44100);
    const audio2 = makeWavBuffer(100, 8000);
    const msg = makeUserMessage([
      makeFilePart(audio1, 'audio/wav'),
      { type: 'text', text: 'between' },
      makeFilePart(audio2, 'audio/wav'),
    ]);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('An audio clip.'));
    const deps = makeDeps({ config, generateText });
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    expect(content[0]?.text).toContain('ID 0-0');
    expect(content[2]?.text).toContain('ID 0-2');
  });

  it('uses general description system prompt for context transformation', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps);
    const args = generateText.mock.calls[0]?.[0] as {
      system: string;
    };
    // Context transformation uses the general description prompt
    expect(args.system).toBe('Describe this audio.');
  });
});

describe('AudioInputOptimizer — hybrid description generation', () => {
  it('caches general description across transformer calls', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const model = makeModel({ inputCapabilities: {} });

    await runTransformer([msg], model, deps);
    await runTransformer([msg], model, deps);

    // generateText should only be called once — the second call uses cache
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent requests for identical audio', async () => {
    const audio = makeWavBuffer(200, 44100);
    // Two identical audio clips in the same message
    const msg = makeUserMessage([
      makeFilePart(audio, 'audio/wav'),
      makeFilePart(audio, 'audio/wav'),
    ]);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const model = makeModel({ inputCapabilities: {} });

    const content = getContent(await runTransformer([msg], model, deps), 0);

    // Both audio clips should get descriptions
    expect(content[0]?.type).toBe('text');
    expect(content[1]?.type).toBe('text');
    // generateText should be called only once — in-flight dedup
    // prevents the second concurrent request from firing.
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('does not call generateText for audio-capable models', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi.fn();
    const deps = makeDeps({ config, generateText });
    const content = getContent(
      await runTransformer([msg], makeModel(), deps),
      0,
    );
    // Audio passes through unchanged (as file part)
    expect(content[0]?.type).toBe('file');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('does not call generateText when no audio helpers configured', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const generateText = vi.fn();
    const deps = makeDeps({ generateText });
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "Can't hear this audio. Audio input isn't supported.",
    );
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('AudioInputOptimizer — listenAudio tool-call stripping', () => {
  it('strips listenAudio tool calls and inlines results when model is audio-capable', async () => {
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const audioModel = makeModel();

    const history: ModelMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'What is in this audio?' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'listenAudio',
            input: { id: '0-0' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'listenAudio',
            output: { type: 'text', value: 'A sine wave with text.' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'The audio shows a sine wave.' }],
      },
    ];

    const result = await runTransformer(history, audioModel, deps);

    // The assistant tool-call message should have the tool-call replaced
    // with an inline text result
    const assistantMsg = result[1] as ModelMessage;
    expect(assistantMsg.role).toBe('assistant');
    const assistantContent = assistantMsg.content as Array<
      Record<string, unknown>
    >;
    const toolCallParts = assistantContent.filter(
      (p) => p.type === 'tool-call',
    );
    expect(toolCallParts).toHaveLength(0);
    const inlineResult = assistantContent.find(
      (p) =>
        p.type === 'text' &&
        typeof p.text === 'string' &&
        p.text.includes('[listenAudio result:'),
    );
    expect(inlineResult).toBeDefined();

    // The tool message should be removed (it only had listenAudio results)
    const toolMessages = result.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(0);

    // The final assistant message should be preserved
    const finalMsg = result[result.length - 1] as ModelMessage;
    expect(finalMsg.role).toBe('assistant');
  });

  it('preserves listenAudio tool calls when model receives the tool', async () => {
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const nonAudioModel = makeModel({ inputCapabilities: {} });

    const history: ModelMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'What is in this audio?' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'listenAudio',
            input: { id: '0-0' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'listenAudio',
            output: { type: 'text', value: 'A sine wave with text.' },
          },
        ],
      },
    ];

    const result = await runTransformer(history, nonAudioModel, deps);

    // Tool-call should be preserved in the assistant message
    const assistantMsg = result[1] as ModelMessage;
    const assistantContent = assistantMsg.content as Array<
      Record<string, unknown>
    >;
    const toolCallParts = assistantContent.filter(
      (p) => p.type === 'tool-call',
    );
    expect(toolCallParts).toHaveLength(1);
    expect(toolCallParts[0]?.toolName).toBe('listenAudio');

    // Tool message should be preserved
    const toolMessages = result.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
  });

  it('preserves non-listenAudio tool calls when stripping', async () => {
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const audioModel = makeModel();

    const history: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'listenAudio',
            input: { id: '0-0' },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-2',
            toolName: 'otherTool',
            input: { query: 'test' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'listenAudio',
            output: { type: 'text', value: 'A sine wave.' },
          },
          {
            type: 'tool-result',
            toolCallId: 'call-2',
            toolName: 'otherTool',
            output: { type: 'text', value: 'other result' },
          },
        ],
      },
    ];

    const result = await runTransformer(history, audioModel, deps);

    // listenAudio tool-call should be replaced with text
    const assistantMsg = result[0] as ModelMessage;
    const assistantContent = assistantMsg.content as Array<
      Record<string, unknown>
    >;
    const remainingToolCalls = assistantContent.filter(
      (p) => p.type === 'tool-call',
    );
    expect(remainingToolCalls).toHaveLength(1);
    expect(remainingToolCalls[0]?.toolName).toBe('otherTool');

    // Tool message should still have the otherTool result
    const toolMessages = result.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const toolContent = toolMessages[0]?.content as Array<
      Record<string, unknown>
    >;
    const remainingResults = toolContent.filter(
      (p) => p.type === 'tool-result',
    );
    expect(remainingResults).toHaveLength(1);
    expect(remainingResults[0]?.toolName).toBe('otherTool');
  });

  it('does not strip listenAudio calls when no listenAudio calls exist', async () => {
    const config = makeAudioConfig(['audio:whisper']);
    const deps = makeDeps({ config });
    const audioModel = makeModel();

    const history: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ];

    const result = await runTransformer(history, audioModel, deps);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('assistant');
  });
});

describe('AudioInputOptimizer — introspection with fallback', () => {
  it('reports descriptionCacheSize and registeredAudio after fallback', async () => {
    const audio = makeWavBuffer(200, 44100);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const ext = createAudioInputOptimizerExt.create(deps);
    const nonAudioModel = makeModel({ inputCapabilities: {} });
    await ext.contextTransformer?.([msg], nonAudioModel);

    const state = ext.introspect?.() as Record<string, unknown>;
    expect(state.descriptionCacheSize).toBe(1);
    expect(state.registeredAudio).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// listenAudio tool
// ---------------------------------------------------------------------------

describe('AudioInputOptimizer — getTools()', () => {
  it('returns listenAudio tool when model lacks audio support and audio models are configured', () => {
    const config = makeAudioConfig(['audio:whisper']);
    const ext = createAudioInputOptimizerExt.create(makeDeps({ config }));
    const tools = ext.getTools?.(makeModel({ inputCapabilities: {} }));
    expect(Object.keys(tools ?? {})).toEqual(['listenAudio']);
  });

  it('returns empty toolset when model supports audio input', () => {
    const config = makeAudioConfig(['audio:whisper']);
    const ext = createAudioInputOptimizerExt.create(makeDeps({ config }));
    const tools = ext.getTools?.(
      makeModel({ inputCapabilities: { audio: DEFAULT_AUDIO_CAPS } }),
    );
    expect(tools).toEqual({});
  });

  it('returns empty toolset when model lacks audio support but no audio models configured', () => {
    const ext = createAudioInputOptimizerExt.create(makeDeps());
    const tools = ext.getTools?.(makeModel({ inputCapabilities: {} }));
    expect(tools).toEqual({});
  });

  it('returns empty toolset when audio models lack audio capability', () => {
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'audioListening' ? ['audio:no-audio-model'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {},
      })),
    } as unknown as ExtensionDeps['config'];
    const ext = createAudioInputOptimizerExt.create(makeDeps({ config }));
    const tools = ext.getTools?.(makeModel({ inputCapabilities: {} }));
    expect(tools).toEqual({});
  });
});

describe('AudioInputOptimizer — listenAudio tool execute', () => {
  /** Helper: creates an extension, runs the context transformer to register
   * an audio clip, then returns the tool execute function. */
  async function setupToolAndAudio(
    audio: Buffer,
    deps: ExtensionDeps,
  ): Promise<(input: { id: string; lookFor: string }) => Promise<string>> {
    const ext = createAudioInputOptimizerExt.create(deps);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const nonAudioModel = makeModel({ inputCapabilities: {} });
    await ext.contextTransformer?.([msg], nonAudioModel);
    const tools = ext.getTools?.(nonAudioModel) ?? {};
    const listenAudio = tools.listenAudio as unknown as {
      execute: (input: { id: string; lookFor?: string }) => Promise<string>;
    };
    return listenAudio.execute as (input: {
      id: string;
      lookFor: string;
    }) => Promise<string>;
  }

  it('passes tool system prompt and audio to generateText on tool execute', async () => {
    const audio = makeWavBuffer(200, 44100);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndAudio(audio, deps);
    // Use lookFor to force a second generateText call (without lookFor,
    // the cached general description is returned and no new call is made)
    const result = await execute({ id: '0-0', lookFor: 'speech content' });
    expect(result).toBe('A 440 Hz sine wave tone.');
    expect(generateText).toHaveBeenCalledTimes(2);
    const toolArgs = generateText.mock.calls[1]?.[0] as {
      modelIds: string[];
      system: string;
      messages: ModelMessage[];
    };
    expect(toolArgs.modelIds).toEqual(['audio:whisper']);
    // Tool execute uses the tool prompt, not the general description prompt
    expect(toolArgs.system).toBe('Answer the question about the audio.');
    expect(toolArgs.messages).toHaveLength(1);
    expect(toolArgs.messages[0]?.role).toBe('user');
    // First call (context transformation) uses the general description prompt
    const ctxArgs = generateText.mock.calls[0]?.[0] as { system: string };
    expect(ctxArgs.system).toBe('Describe this audio.');
  });

  it('passes lookFor as additional text content when provided', async () => {
    const audio = makeWavBuffer(200, 44100);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('Someone says hello.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndAudio(audio, deps);
    await execute({ id: '0-0', lookFor: 'speech content' });
    // First call is the general description during context transformation,
    // second call is the targeted tool execute with lookFor.
    expect(generateText).toHaveBeenCalledTimes(2);
    const args = generateText.mock.calls[1]?.[0] as {
      messages: ModelMessage[];
    };
    const content = args.messages[0]?.content as Array<Record<string, unknown>>;
    // Should contain the audio part and a text part with lookFor
    expect(content).toHaveLength(2);
    expect(content.some((p) => p.type === 'file')).toBe(true);
    const textPart = content.find((p) => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart?.text).toContain('speech content');
  });

  it('returns error message for unknown audio ID', async () => {
    const audio = makeWavBuffer(200, 44100);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndAudio(audio, deps);
    const result = await execute({ id: '99-99', lookFor: 'test' });
    expect(result).toContain('not found');
    // generateText was called once during context transformation
    // (for the general description), but not for the unknown ID.
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('uses chat model fallback when audio models fail', async () => {
    const audio = makeWavBuffer(200, 44100);
    const config = makeAudioConfig(
      ['audio:whisper'],
      ['chat:gpt-4o'],
      ['chat:gpt-4o'],
    );
    const generateText = vi
      .fn()
      .mockResolvedValueOnce(genSuccess('General description.'))
      .mockResolvedValueOnce(genFailure())
      .mockResolvedValueOnce(genSuccess('Chat model description.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndAudio(audio, deps);
    const result = await execute({ id: '0-0', lookFor: 'details' });
    expect(result).toBe('Chat model description.');
    expect(generateText).toHaveBeenCalledTimes(3);
    const thirdCall = generateText.mock.calls[2]?.[0] as {
      modelIds: string[];
    };
    expect(thirdCall.modelIds).toEqual(['chat:gpt-4o']);
  });

  it('returns failure message when both audio and chat fallback fail', async () => {
    const audio = makeWavBuffer(200, 44100);
    const config = makeAudioConfig(
      ['audio:whisper'],
      ['chat:gpt-4o'],
      ['chat:gpt-4o'],
    );
    const generateText = vi.fn().mockResolvedValue(genFailure());
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndAudio(audio, deps);
    const result = await execute({ id: '0-0', lookFor: 'details' });
    expect(result).toContain('Unable to analyze');
  });

  it('skips chat fallback when no chat models have audio capability', async () => {
    const audio = makeWavBuffer(200, 44100);
    const config = {
      getModelSelection: vi.fn((p: string) => {
        if (p === 'audioListening') return ['audio:whisper'];
        if (p === 'chat') return ['chat:text-only-model'];
        return [];
      }),
      resolveModelInfo: vi.fn((id: string) => {
        if (id === 'audio:whisper') {
          return {
            contextSize: 128_000,
            displayName: undefined,
            inputCapabilities: { audio: DEFAULT_AUDIO_CAPS },
          };
        }
        return {
          contextSize: 128_000,
          displayName: undefined,
          inputCapabilities: {},
        };
      }),
    } as unknown as ExtensionDeps['config'];
    const generateText = vi.fn().mockResolvedValue(genFailure());
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndAudio(audio, deps);
    const result = await execute({ id: '0-0', lookFor: 'details' });
    expect(result).toContain('Unable to analyze');
    // Called during context transformation and during tool execute
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('generates separate descriptions for different lookFor values', async () => {
    const audio = makeWavBuffer(200, 44100);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValueOnce(genSuccess('General description.'))
      .mockResolvedValueOnce(genSuccess('Description for speech.'))
      .mockResolvedValueOnce(genSuccess('Description for music.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndAudio(audio, deps);
    const r1 = await execute({ id: '0-0', lookFor: 'speech' });
    const r2 = await execute({ id: '0-0', lookFor: 'music' });
    expect(r1).toBe('Description for speech.');
    expect(r2).toBe('Description for music.');
    // 3 calls: general description (context transformer) + 2 targeted
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it('reports descriptionCacheSize in introspect after tool call', async () => {
    const audio = makeWavBuffer(200, 44100);
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });
    const ext = createAudioInputOptimizerExt.create(deps);
    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const nonAudioModel = makeModel({ inputCapabilities: {} });
    await ext.contextTransformer?.([msg], nonAudioModel);
    const tools = ext.getTools?.(nonAudioModel) ?? {};
    const listenAudio = tools.listenAudio as unknown as {
      execute: (input: { id: string; lookFor: string }) => Promise<string>;
    };
    await listenAudio.execute?.({ id: '0-0', lookFor: 'test' });
    const state = ext.introspect?.() as Record<string, unknown>;
    expect(state.descriptionCacheSize).toBe(1);
  });
});

describe('AudioInputOptimizer — URL audio with fallback', () => {
  it('replaces URL audio with placeholder for non-audio models with audio helpers', async () => {
    const part: FilePart = {
      type: 'file',
      data: { type: 'url', url: new URL('https://example.com/audio.wav') },
      mediaType: 'audio/wav',
    };
    const config = makeAudioConfig(['audio:whisper']);
    const generateText = vi.fn();
    const deps = makeDeps({ config, generateText });
    const msg = makeUserMessage([part]);
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    // URL audio can't be extracted for description generation —
    // should be replaced with placeholder text, not passed through.
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain("Can't directly hear audio");
    expect(content[0]?.text).toContain('listenAudio');
    // generateText should NOT be called — no inline buffer to describe
    expect(generateText).not.toHaveBeenCalled();
  });

  it('replaces URL audio with unsupported text for non-audio models without audio helpers', async () => {
    const part: FilePart = {
      type: 'file',
      data: { type: 'url', url: new URL('https://example.com/audio.wav') },
      mediaType: 'audio/wav',
    };
    const msg = makeUserMessage([part]);
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} })),
      0,
    );
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "Can't hear this audio. Audio input isn't supported.",
    );
  });
});

describe('AudioInputOptimizer — audio helper optimization', () => {
  it('optimizes audio for the audio helper model before sending', async () => {
    // Large WAV that exceeds the audio model's maxBytes of 5000
    const audio = makeWavBuffer(1000, 44100, 2);
    expect(audio.length).toBeGreaterThan(5000);
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'audioListening' ? ['audio:whisper'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {
          audio: {
            mediaTypes: ['audio/mpeg'],
            maxBytes: 5000,
          },
        },
      })),
    } as unknown as ExtensionDeps['config'];
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A compressed tone.'));
    const deps = makeDeps({ config, generateText });

    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps);

    // The audio passed to generateText should be converted to mp3 and under 5000 bytes
    const args = generateText.mock.calls[0]?.[0] as {
      messages: ModelMessage[];
    };
    const content = args.messages[0]?.content as Array<Record<string, unknown>>;
    const audioPart = content.find((p) => p.type === 'file');
    expect(audioPart).toBeDefined();
    expect(audioPart?.mediaType).toBe('audio/mpeg');
    const part = audioPart as { data: { data: string } };
    expect(Buffer.from(part.data.data, 'base64').length).toBeLessThanOrEqual(
      5000,
    );
  });

  it('caches optimized audio for audio helper across calls', async () => {
    const audio = makeWavBuffer(1000, 44100, 2);
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'audioListening' ? ['audio:whisper'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {
          audio: {
            mediaTypes: ['audio/mpeg'],
            maxBytes: 5000,
          },
        },
      })),
    } as unknown as ExtensionDeps['config'];
    const generateText = vi
      .fn()
      .mockResolvedValueOnce(genSuccess('General.'))
      .mockResolvedValueOnce(genSuccess('Look for speech.'))
      .mockResolvedValueOnce(genSuccess('Look for music.'));
    const deps = makeDeps({ config, generateText });

    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    const nonAudioModel = makeModel({ inputCapabilities: {} });
    const ext = createAudioInputOptimizerExt.create(deps);
    // Context transformer generates general description (call 1)
    await ext.contextTransformer?.([msg], nonAudioModel);
    const tools = ext.getTools?.(nonAudioModel) ?? {};
    const execute = tools.listenAudio?.execute as (input: {
      id: string;
      lookFor?: string;
    }) => Promise<string>;

    // Two targeted tool calls with different lookFor — each triggers
    // describeAudio (calls 2 and 3), but the audio passed to the
    // audio model should be the same cached optimized object.
    await execute({ id: '0-0', lookFor: 'speech' });
    await execute({ id: '0-0', lookFor: 'music' });

    const args1 = generateText.mock.calls[1]?.[0] as {
      messages: ModelMessage[];
    };
    const args2 = generateText.mock.calls[2]?.[0] as {
      messages: ModelMessage[];
    };
    const aud1 = (
      (args1.messages[0] as ModelMessage).content as Array<
        Record<string, unknown>
      >
    ).find((p) => p.type === 'file');
    const aud2 = (
      (args2.messages[0] as ModelMessage).content as Array<
        Record<string, unknown>
      >
    ).find((p) => p.type === 'file');
    // Same cached object reference — audio was only optimized once
    expect(aud1).toBe(aud2);
  });

  it('passes audio through unchanged when audio model has no constraints', async () => {
    const audio = makeWavBuffer(100, 8000);
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'audioListening' ? ['audio:whisper'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {
          audio: {
            mediaTypes: ['audio/wav'],
            maxBytes: 25_165_824,
          },
        },
      })),
    } as unknown as ExtensionDeps['config'];
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A 440 Hz sine wave tone.'));
    const deps = makeDeps({ config, generateText });

    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps);

    const args = generateText.mock.calls[0]?.[0] as {
      messages: ModelMessage[];
    };
    const content = args.messages[0]?.content as Array<Record<string, unknown>>;
    const audioPart = content.find((p) => p.type === 'file');
    // Audio is within all limits — should be passed through as-is
    const part = audioPart as { data: { data: string } };
    expect(Buffer.from(part.data.data, 'base64')).toEqual(audio);
  });

  it('converts format for audio helper when format not supported', async () => {
    // Audio model only supports mp3, audio is wav
    const audio = makeWavBuffer(200, 44100);
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'audioListening' ? ['audio:whisper'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {
          audio: {
            mediaTypes: ['audio/mpeg'],
            maxBytes: 25_165_824,
          },
        },
      })),
    } as unknown as ExtensionDeps['config'];
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('A compressed tone.'));
    const deps = makeDeps({ config, generateText });

    const msg = makeUserMessage([makeFilePart(audio, 'audio/wav')]);
    await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps);

    const args = generateText.mock.calls[0]?.[0] as {
      messages: ModelMessage[];
    };
    const content = args.messages[0]?.content as Array<Record<string, unknown>>;
    const audioPart = content.find((p) => p.type === 'file');
    expect(audioPart?.mediaType).toBe('audio/mpeg');
  });
});

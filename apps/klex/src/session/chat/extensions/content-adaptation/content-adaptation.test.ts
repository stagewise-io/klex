import type { FilePart, ModelMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cache,
  descriptionCache,
  inflightDescriptions,
  runOptimization,
} from '../audio-input-optimizer/audio-processing';
import {
  genFailure,
  genSuccess,
  makeDeps,
  makeModel,
} from '../audio-input-optimizer/test-helpers';
import type { GenerateTextResult } from '../extension-api';
import { adaptAudioContent } from './content-adaptation';

vi.mock('../audio-input-optimizer/audio-processing', () => ({
  cache: new Map(),
  descriptionCache: new Map(),
  inflightDescriptions: new Map(),
  isFfmpegAvailable: () => true,
  resolveEffectiveAudio: (caps: { audio?: object }) => ({
    supports: caps.audio !== undefined,
    ...caps.audio,
  }),
  extractAudioBuffer: (part: FilePart) =>
    Buffer.from(part.data as string, 'base64'),
  runOptimization: vi.fn(async (_buffer, part, settings) => ({
    ...part,
    mediaType: settings.mediaTypes?.[0] ?? 'audio/wav',
    data: 'optimized',
  })),
}));

const helper = { providerId: 'test', modelId: 'helper' };
const original: ModelMessage[] = [
  {
    role: 'user',
    content: [{ type: 'file', mediaType: 'audio/mp4', data: 'YXVkaW8=' }],
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  cache.clear();
  descriptionCache.clear();
  inflightDescriptions.clear();
});

function depsForAudio() {
  const deps = makeDeps({
    generateText: vi.fn().mockResolvedValue(genSuccess('Meet at noon.')),
  });
  vi.mocked(deps.config.getModelSelection).mockImplementation((purpose) =>
    purpose === 'audioListening' ? [helper] : [],
  );
  vi.mocked(deps.modelResolver.resolveModelInfo).mockReturnValue({
    contextSize: 20000,
    inputCapabilities: { audio: { mediaTypes: ['audio/wav'], maxBytes: 1000 } },
  } as never);
  return deps;
}

describe('content adaptation', () => {
  it('adapts SDK tool audio outputs without changing canonical tool results', async () => {
    const deps = depsForAudio();
    const history: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call',
            toolName: 'record',
            output: {
              type: 'content',
              value: [
                { type: 'file-data', mediaType: 'audio/mp4', data: 'YXVkaW8=' },
              ],
            },
          },
        ],
      },
    ];
    const before = structuredClone(history);
    const text = await adaptAudioContent(
      history,
      deps,
      makeModel({ inputCapabilities: {} }),
    );
    expect(JSON.stringify(text)).toContain('Meet at noon.');
    expect(JSON.stringify(text)).not.toContain('file-data');
    const native = await adaptAudioContent(history, deps, makeModel());
    expect(JSON.stringify(native)).toContain('file-data');
    expect(history).toEqual(before);
  });
  it('optimizes native audio for target limits, caches it, and preserves the source', async () => {
    const deps = depsForAudio();
    const before = structuredClone(original);
    const model = makeModel({
      inputCapabilities: {
        audio: {
          mediaTypes: ['audio/mpeg'],
          maxBytes: 1234,
          maxLengthSeconds: 12,
        },
      },
    });
    const result = await adaptAudioContent(original, deps, model);
    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'audio/mpeg', data: 'optimized' }],
      },
    ]);
    expect(runOptimization).toHaveBeenCalledWith(
      expect.any(Buffer),
      before[0]?.content[0],
      expect.objectContaining({ maxBytes: 1234, maxLengthSeconds: 12 }),
    );
    await adaptAudioContent(original, deps, model);
    expect(runOptimization).toHaveBeenCalledTimes(1);
    expect(original).toEqual(before);
    expect(deps.generateText).not.toHaveBeenCalled();
  });

  it('caches and deduplicates derived transcription while retaining native audio for later targets', async () => {
    const deps = depsForAudio();
    const before = structuredClone(original);
    const textModel = makeModel({ inputCapabilities: {} });
    const [first, second] = await Promise.all([
      adaptAudioContent(original, deps, textModel),
      adaptAudioContent(original, deps, textModel),
    ]);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toContain('transcription-description');
    expect(JSON.stringify(first)).toContain('Meet at noon.');
    await adaptAudioContent(original, deps, textModel);
    expect(deps.generateText).toHaveBeenCalledTimes(1);
    const native = await adaptAudioContent(original, deps, makeModel());
    expect(JSON.stringify(native)).toContain('"type":"file"');
    expect(JSON.stringify(native)).not.toContain('Meet at noon.');
    expect(original).toEqual(before);
  });

  it('re-optimizes helper fallback from original audio for different limits', async () => {
    const deps = depsForAudio();
    const second = { providerId: 'test', modelId: 'second' };
    vi.mocked(deps.config.getModelSelection).mockImplementation((purpose) =>
      purpose === 'audioListening' ? [helper, second] : [],
    );
    vi.mocked(deps.modelResolver.resolveModelInfo).mockImplementation(
      (entry) =>
        ({
          contextSize: 20000,
          inputCapabilities: {
            audio: {
              mediaTypes: [
                entry.modelId === 'helper' ? 'audio/wav' : 'audio/mpeg',
              ],
            },
          },
        }) as never,
    );
    vi.mocked(deps.generateText)
      .mockResolvedValueOnce(genFailure())
      .mockResolvedValueOnce(
        genSuccess('Fallback transcript') as GenerateTextResult,
      );
    await adaptAudioContent(
      original,
      deps,
      makeModel({ inputCapabilities: {} }),
    );
    const calls = vi.mocked(deps.generateText).mock.calls;
    expect(calls.map(([args]) => args.modelIds)).toEqual([[helper], [second]]);
    expect(JSON.stringify(calls[0]?.[0].messages)).toContain('audio/wav');
    expect(JSON.stringify(calls[1]?.[0].messages)).toContain('audio/mpeg');
    expect(
      vi.mocked(runOptimization).mock.calls.map((call) => call[1].mediaType),
    ).toEqual(['audio/mp4', 'audio/mp4']);
  });
});

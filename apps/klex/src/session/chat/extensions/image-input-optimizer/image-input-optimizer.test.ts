import type { FilePart, ModelMessage, ToolResultPart, UserContent } from 'ai';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionDeps, ResolvedModel } from '../extension-api';
import {
  BoundedCache,
  clearImageInputOptimizerCache,
  createImageInputOptimizerExt,
} from './image-input-optimizer';

// --- mocks ---

vi.mock('./vision-system-prompt.md', () => ({
  default: 'Describe this image.',
}));

vi.mock('./vision-tool-system-prompt.md', () => ({
  default: 'Answer the question about the image.',
}));

// --- helpers ---

function makeDeps(overrides?: Partial<ExtensionDeps>): ExtensionDeps {
  return {
    getHistory: vi.fn(() => []),
    insertMessageAfter: vi.fn(() => true),
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    config: {
      getModelSelection: vi.fn(() => []),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {},
      })),
    } as unknown as ExtensionDeps['config'],
    generateText: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ExtensionDeps['logger'],
    logging: {} as unknown as ExtensionDeps['logging'],
    mcp: {} as unknown as ExtensionDeps['mcp'],
    sessionId: 'test-session',
    getDataDir: vi.fn(() => '/tmp/test-ext-data'),
    ...overrides,
  };
}

const DEFAULT_IMAGE_CAPS = {
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxBytes: 4_194_304,
};

function makeModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    modelId: 'test:model',
    displayName: 'Test Model',
    contextSize: 128_000,
    inputCapabilities: {
      image: DEFAULT_IMAGE_CAPS,
    },
    ...overrides,
  };
}

async function makeImageBuffer(
  width: number,
  height: number,
  format: 'png' | 'webp' | 'jpeg' = 'png',
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: 'red' },
  })
    .toFormat(format)
    .toBuffer();
}

function makeFilePart(
  buffer: Buffer,
  mediaType = 'image/png',
  filename?: string,
): FilePart {
  return {
    type: 'file',
    data: { type: 'data', data: buffer },
    mediaType,
    ...(filename !== undefined && { filename }),
  };
}

function makeUserMessage(content: UserContent): ModelMessage {
  return { role: 'user', content };
}

/** Extracts the content array from a transformed user message. */
function getContent(
  result: ModelMessage[],
  msgIndex: number,
): Array<Record<string, unknown>> {
  const msg = result[msgIndex] as ModelMessage;
  return msg.content as unknown as Array<Record<string, unknown>>;
}

/** Extracts the base64 data string from a file part's data field. */
function extractFileData(part: Record<string, unknown> | undefined): string {
  const data = part?.data as { data: string } | undefined;
  return data?.data ?? '';
}

async function runTransformer(
  history: ModelMessage[],
  model: ResolvedModel,
  deps?: ExtensionDeps,
): Promise<ModelMessage[]> {
  const ext = createImageInputOptimizerExt.create(deps ?? makeDeps());
  const result = await ext.contextTransformer?.(history, model);
  return Array.isArray(result)
    ? result
    : (result as { history: ModelMessage[] }).history;
}

/** Builds a successful generateText result. */
function genSuccess(text: string): {
  success: true;
  text: string;
  modelId: string;
  usage: Record<string, unknown>;
} {
  return {
    success: true,
    text,
    modelId: 'vision:model',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

/** Builds a failed generateText result. */
function genFailure(): {
  success: false;
  failureReason: 'all-models-failed';
} {
  return { success: false, failureReason: 'all-models-failed' };
}

/** Config mock that returns vision models with image capability. */
function makeVisionConfig(
  visionModelIds: string[],
  chatModelIds: string[] = [],
  visionChatModelIds: string[] = [],
) {
  return {
    getModelSelection: vi.fn((purpose: string) => {
      if (purpose === 'imageVision') return visionModelIds;
      if (purpose === 'chat') return chatModelIds;
      return [];
    }),
    resolveModelInfo: vi.fn((id: string) => {
      if (visionModelIds.includes(id) || visionChatModelIds.includes(id)) {
        return {
          contextSize: 128_000,
          displayName: undefined,
          inputCapabilities: { image: DEFAULT_IMAGE_CAPS },
        };
      }
      return {
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {},
      };
    }),
  } as unknown as ExtensionDeps['config'];
}

// --- tests ---

beforeEach(() => {
  vi.clearAllMocks();
  clearImageInputOptimizerCache();
});

describe('ImageInputOptimizer — image detection', () => {
  it('detects FilePart with image/png mediaType', async () => {
    const img = await makeImageBuffer(50, 50);
    const msg = makeUserMessage([
      { type: 'text', text: 'hello' },
      makeFilePart(img, 'image/png'),
    ]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('text');
    expect(content[1]?.type).toBe('file');
  });

  it('detects FilePart with bare image mediaType', async () => {
    const img = await makeImageBuffer(50, 50);
    const msg = makeUserMessage([makeFilePart(img, 'image')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('file');
  });

  it('detects deprecated ImagePart', async () => {
    const img = await makeImageBuffer(50, 50);
    const msg = makeUserMessage([{ type: 'image', image: img }]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    // ImagePart with inline data gets normalized to FilePart
    expect(content[0]?.type).toBe('file');
  });

  it('leaves non-image FilePart untouched', async () => {
    const msg = makeUserMessage([
      makeFilePart(Buffer.from('not-an-image'), 'application/pdf'),
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

describe('ImageInputOptimizer — URL images skipped', () => {
  it('passes FilePart with URL data unchanged', async () => {
    const part: FilePart = {
      type: 'file',
      data: { type: 'url', url: new URL('https://example.com/image.png') },
      mediaType: 'image/png',
    };
    const msg = makeUserMessage([part]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]).toEqual(part);
  });

  it('passes FilePart with bare remote URL unchanged', async () => {
    const url = new URL('https://example.com/image.png');
    const part = { type: 'file' as const, data: url, mediaType: 'image/png' };
    const msg = makeUserMessage([part]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]).toEqual(part);
  });

  it('processes FilePart with data URL (inline base64)', async () => {
    const img = await makeImageBuffer(3000, 3000, 'png');
    const dataUrl = new URL(`data:image/png;base64,${img.toString('base64')}`);
    const part: FilePart = {
      type: 'file',
      data: { type: 'url', url: dataUrl },
      mediaType: 'image/png',
    };
    const msg = makeUserMessage([part]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    // Should be processed and transformed (webp preferred, resized to <=2048)
    expect(content[0]?.type).toBe('file');
    expect(content[0]?.mediaType).toBe('image/webp');
  });
});

describe('ImageInputOptimizer — metadata stripping', () => {
  it('strips EXIF metadata from transformed images', async () => {
    const imgWithMeta = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: 'red' },
    })
      .withExif({ IFD0: { Make: 'TestCamera' } })
      .png()
      .toBuffer();

    const inputMeta = await sharp(imgWithMeta).metadata();
    expect(inputMeta.exif).toBeDefined();

    const msg = makeUserMessage([makeFilePart(imgWithMeta, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
              maxWidth: 500,
            },
          },
        }),
      ),
      0,
    );
    const outputBuffer = extractFileData(content[0]);
    const outputMeta = await sharp(
      Buffer.from(outputBuffer, 'base64'),
    ).metadata();
    expect(outputMeta.exif).toBeUndefined();
    expect(outputMeta.iptc).toBeUndefined();
    expect(outputMeta.xmp).toBeUndefined();
    expect(outputMeta.icc).toBeUndefined();
  });
});

describe('ImageInputOptimizer — resize enforcement', () => {
  it('resizes images exceeding maxWidth', async () => {
    const img = await makeImageBuffer(3000, 100, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
              maxWidth: 500,
            },
          },
        }),
      ),
      0,
    );
    const data = extractFileData(content[0]);
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBeLessThanOrEqual(500);
  });

  it('resizes images exceeding maxHeight', async () => {
    const img = await makeImageBuffer(100, 3000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
              maxHeight: 500,
            },
          },
        }),
      ),
      0,
    );
    const data = extractFileData(content[0]);
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.height).toBeLessThanOrEqual(500);
  });
});

describe('ImageInputOptimizer — aspect ratio preservation', () => {
  it('preserves aspect ratio when resizing to maxWidth', async () => {
    // 8:1 aspect ratio (800x100), maxWidth 400 → expect 400x50
    const img = await makeImageBuffer(800, 100, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
              maxWidth: 400,
            },
          },
        }),
      ),
      0,
    );
    const data = extractFileData(content[0]);
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(50);
    // Aspect ratio preserved: 400/50 === 800/100 === 8
    expect((meta.width ?? 0) / (meta.height ?? 0)).toBeCloseTo(8, 5);
  });

  it('preserves aspect ratio when resizing to maxHeight', async () => {
    // 1:4 aspect ratio (100x400), maxHeight 100 → expect 25x100
    const img = await makeImageBuffer(100, 400, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
              maxHeight: 100,
            },
          },
        }),
      ),
      0,
    );
    const data = extractFileData(content[0]);
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBe(25);
    expect(meta.height).toBe(100);
    expect((meta.width ?? 0) / (meta.height ?? 0)).toBeCloseTo(0.25, 5);
  });

  it('preserves aspect ratio when scaling down for maxTotalPixels', async () => {
    // 4:1 aspect ratio (2000x500) = 1,000,000 px, maxTotalPixels 100,000
    // → scale ~0.316 → ~632x158
    const img = await makeImageBuffer(2000, 500, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
              maxTotalPixels: 100_000,
              maxWidth: 10000,
              maxHeight: 10000,
            },
          },
        }),
      ),
      0,
    );
    const data = extractFileData(content[0]);
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    const ratio = (meta.width ?? 0) / (meta.height ?? 0);
    expect(ratio).toBeCloseTo(4, 1);
    expect((meta.width ?? 0) * (meta.height ?? 0)).toBeLessThanOrEqual(100_000);
  });

  it('preserves aspect ratio when both maxWidth and maxHeight bind', async () => {
    // 3:1 aspect ratio (900x300), maxWidth 300 + maxHeight 200
    // fit: 'inside' → 300x100 (width binds, height stays under 200)
    const img = await makeImageBuffer(900, 300, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
              maxWidth: 300,
              maxHeight: 200,
            },
          },
        }),
      ),
      0,
    );
    const data = extractFileData(content[0]);
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBeLessThanOrEqual(300);
    expect(meta.height).toBeLessThanOrEqual(200);
    expect((meta.width ?? 0) / (meta.height ?? 0)).toBeCloseTo(3, 1);
  });
});

describe('ImageInputOptimizer — maxTotalPixels enforcement', () => {
  it('scales down images exceeding maxTotalPixels', async () => {
    const img = await makeImageBuffer(2000, 2000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
              maxTotalPixels: 500_000,
            },
          },
        }),
      ),
      0,
    );
    const data = extractFileData(content[0]);
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect((meta.width ?? 0) * (meta.height ?? 0)).toBeLessThanOrEqual(500_000);
  });
});

describe('ImageInputOptimizer — maxDataSize enforcement', () => {
  it('re-encodes images exceeding maxDataSize until under limit', async () => {
    const img = await makeImageBuffer(2000, 2000, 'png');
    expect(img.length).toBeGreaterThan(10_000);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: { mediaTypes: ['image/png'], maxBytes: 10_000 },
          },
        }),
      ),
      0,
    );
    const data = extractFileData(content[0]);
    expect(Buffer.from(data, 'base64').length).toBeLessThanOrEqual(10_000);
  });
});

describe('ImageInputOptimizer — format preference', () => {
  it('prefers webp when webp is in mediaTypes', async () => {
    const img = await makeImageBuffer(3000, 3000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.mediaType).toBe('image/webp');
  });

  it('converts to first supported format from mediaTypes', async () => {
    const img = await makeImageBuffer(3000, 3000, 'webp');
    const msg = makeUserMessage([makeFilePart(img, 'image/webp')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png', 'image/jpeg'],
              maxBytes: 4_194_304,
            },
          },
        }),
      ),
      0,
    );
    expect(content[0]?.mediaType).toBe('image/png');
  }, 15_000);
});

describe('ImageInputOptimizer — supports: false', () => {
  it('replaces image with description + viewImage hint when vision models configured', async () => {
    const img = await makeImageBuffer(100, 100);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "A red square.\n\nFor more specific details about this image, use the 'viewImage' tool with ID 0-0.",
    );
  });

  it('falls back to placeholder when vision model fails to describe', async () => {
    const img = await makeImageBuffer(100, 100);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genFailure());
    const deps = makeDeps({ config, generateText });
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "Can't directly see image. Use tool 'viewImage' with ID 0-0 to get information on image content.",
    );
  });

  it('uses messageIndex-partIndex as image ID for multiple images', async () => {
    const img1 = await makeImageBuffer(100, 100);
    const img2 = await makeImageBuffer(50, 50);
    const msg = makeUserMessage([
      makeFilePart(img1, 'image/png'),
      { type: 'text', text: 'between' },
      makeFilePart(img2, 'image/png'),
    ]);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('An image.'));
    const deps = makeDeps({ config, generateText });
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    expect(content[0]?.text).toContain('ID 0-0');
    expect(content[2]?.text).toContain('ID 0-2');
  });

  it('uses general description system prompt for context transformation', async () => {
    const img = await makeImageBuffer(100, 100);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps);
    const args = generateText.mock.calls[0]?.[0] as {
      system: string;
    };
    // Context transformation uses the general description prompt
    expect(args.system).toBe('Describe this image.');
  });
});

describe('ImageInputOptimizer — hybrid description generation', () => {
  it('caches general description across transformer calls', async () => {
    const img = await makeImageBuffer(100, 100);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    const model = makeModel({ inputCapabilities: {} });

    await runTransformer([msg], model, deps);
    await runTransformer([msg], model, deps);

    // generateText should only be called once — the second call uses cache
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('does not call generateText for vision-capable models', async () => {
    const img = await makeImageBuffer(100, 100);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn();
    const deps = makeDeps({ config, generateText });
    const content = getContent(
      await runTransformer([msg], makeModel(), deps),
      0,
    );
    // Image passes through unchanged (as file part)
    expect(content[0]?.type).toBe('file');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('does not call generateText when no vision helpers configured', async () => {
    const img = await makeImageBuffer(100, 100);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const generateText = vi.fn();
    const deps = makeDeps({ generateText });
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "Can't see the image, you have no vision capabilities or vision model as a helper to see the image.",
    );
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('ImageInputOptimizer — viewImage tool-call stripping', () => {
  it('strips viewImage tool calls and inlines results when model is vision-capable', async () => {
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    const visionModel = makeModel();

    const history: ModelMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'What is in this image?' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'viewImage',
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
            toolName: 'viewImage',
            output: { type: 'text', value: 'A red square with text.' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'The image shows a red square.' }],
      },
    ];

    const result = await runTransformer(history, visionModel, deps);

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
        p.text.includes('[viewImage result:'),
    );
    expect(inlineResult).toBeDefined();

    // The tool message should be removed (it only had viewImage results)
    const toolMessages = result.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(0);

    // The final assistant message should be preserved
    const finalMsg = result[result.length - 1] as ModelMessage;
    expect(finalMsg.role).toBe('assistant');
  });

  it('preserves viewImage tool calls when model receives the tool', async () => {
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    const nonVisionModel = makeModel({ inputCapabilities: {} });

    const history: ModelMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'What is in this image?' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'viewImage',
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
            toolName: 'viewImage',
            output: { type: 'text', value: 'A red square with text.' },
          },
        ],
      },
    ];

    const result = await runTransformer(history, nonVisionModel, deps);

    // Tool-call should be preserved in the assistant message
    const assistantMsg = result[1] as ModelMessage;
    const assistantContent = assistantMsg.content as Array<
      Record<string, unknown>
    >;
    const toolCallParts = assistantContent.filter(
      (p) => p.type === 'tool-call',
    );
    expect(toolCallParts).toHaveLength(1);
    expect(toolCallParts[0]?.toolName).toBe('viewImage');

    // Tool message should be preserved
    const toolMessages = result.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
  });

  it('preserves non-viewImage tool calls when stripping', async () => {
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    const visionModel = makeModel();

    const history: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'viewImage',
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
            toolName: 'viewImage',
            output: { type: 'text', value: 'A red square.' },
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

    const result = await runTransformer(history, visionModel, deps);

    // viewImage tool-call should be replaced with text
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

  it('does not strip viewImage calls when no viewImage calls exist', async () => {
    const config = makeVisionConfig(['vision:gpt-4o']);
    const deps = makeDeps({ config });
    const visionModel = makeModel();

    const history: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ];

    const result = await runTransformer(history, visionModel, deps);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('assistant');
  });
});

describe('ImageInputOptimizer — caching', () => {
  it('shares cache across extension instances', async () => {
    const img = await makeImageBuffer(3000, 3000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const model = makeModel();

    const deps = makeDeps();
    const ext1 = createImageInputOptimizerExt.create(deps);
    const ext2 = createImageInputOptimizerExt.create(deps);

    const r1 = await ext1.contextTransformer?.([msg], model);
    const r2 = await ext2.contextTransformer?.([msg], model);
    const arr1 = Array.isArray(r1)
      ? r1
      : (r1 as { history: ModelMessage[] }).history;
    const arr2 = Array.isArray(r2)
      ? r2
      : (r2 as { history: ModelMessage[] }).history;
    const c1 = arr1[0]?.content as unknown as Array<Record<string, unknown>>;
    const c2 = arr2[0]?.content as unknown as Array<Record<string, unknown>>;

    expect(c1[0]).toBe(c2[0]);
  });

  it('uses different cache entries for different modelIds', async () => {
    const img = await makeImageBuffer(3000, 3000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);

    const model1 = makeModel({ modelId: 'test:model-a' });
    const model2 = makeModel({
      modelId: 'test:model-b',
      inputCapabilities: {
        image: {
          mediaTypes: ['image/png'],
          maxBytes: 4_194_304,
        },
      },
    });

    const result1 = await runTransformer([msg], model1);
    const result2 = await runTransformer([msg], model2);
    const c1 = getContent(result1, 0);
    const c2 = getContent(result2, 0);

    expect(c1[0]).not.toBe(c2[0]);
  });
});

describe('ImageInputOptimizer — multiple images and messages', () => {
  it('processes multiple images in one message independently', async () => {
    const img1 = await makeImageBuffer(3000, 100, 'png');
    const img2 = await makeImageBuffer(100, 3000, 'png');
    const msg = makeUserMessage([
      makeFilePart(img1, 'image/png'),
      { type: 'text', text: 'between' },
      makeFilePart(img2, 'image/png'),
    ]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
              maxWidth: 500,
              maxHeight: 500,
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

  it('processes images across multiple messages', async () => {
    const img = await makeImageBuffer(3000, 3000, 'png');
    const msg1 = makeUserMessage([makeFilePart(img, 'image/png')]);
    const msg2 = makeUserMessage([
      { type: 'text', text: 'second' },
      makeFilePart(img, 'image/png'),
    ]);
    const result = await runTransformer([msg1, msg2], makeModel());
    expect(result).toHaveLength(2);
    const c1 = getContent(result, 0);
    const c2 = getContent(result, 1);
    expect(c1[0]?.type).toBe('file');
    expect(c2[0]?.type).toBe('text');
    expect(c2[1]?.type).toBe('file');
  });
});

describe('ImageInputOptimizer — format-only conversion (no resize needed)', () => {
  it('converts format when image is within size limits but format not supported', async () => {
    // 100x100 is within default 2048 limits — only format is incompatible
    const img = await makeImageBuffer(100, 100, 'webp');
    const msg = makeUserMessage([makeFilePart(img, 'image/webp')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/png'],
              maxBytes: 4_194_304,
            },
          },
        }),
      ),
      0,
    );
    expect(content[0]?.mediaType).toBe('image/png');
    const data = extractFileData(content[0]);
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.format).toBe('png');
    // Dimensions preserved — no resize happened
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
  });
});

describe('ImageInputOptimizer — graceful degradation on unparseable image', () => {
  it('replaces corrupt image with text notification on sharp error', async () => {
    const corruptBuffer = Buffer.from('not-a-real-image-just-bytes');
    const msg = makeUserMessage([makeFilePart(corruptBuffer, 'image/png')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "Can't see the image, you have no vision capabilities or vision model as a helper to see the image.",
    );
  });
});

describe('ImageInputOptimizer — defaults', () => {
  it('applies default constraints when maxWidth/maxHeight not specified', async () => {
    const img = await makeImageBuffer(500, 500);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    const data = extractFileData(content[0]);
    expect(Buffer.from(data, 'base64')).toEqual(img);
  });

  it('applies default maxWidth when maxWidth not specified', async () => {
    const img = await makeImageBuffer(3000, 100, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    const data = extractFileData(content[0]);
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBeLessThanOrEqual(2048);
  });
});

describe('ImageInputOptimizer — introspection', () => {
  it('reports cache size via introspect()', async () => {
    const ext = createImageInputOptimizerExt.create(makeDeps());
    expect(ext.introspect?.()).toEqual({
      cacheSize: 0,
      descriptionCacheSize: 0,
      registeredImages: 0,
    });

    const img = await makeImageBuffer(3000, 3000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    await ext.contextTransformer?.([msg], makeModel());

    expect(ext.introspect?.()).toEqual({
      cacheSize: 1,
      descriptionCacheSize: 0,
      registeredImages: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// viewImage tool
// ---------------------------------------------------------------------------

describe('ImageInputOptimizer — getTools()', () => {
  it('returns viewImage tool when model lacks image support and vision models are configured', () => {
    const config = makeVisionConfig(['vision:gpt-4o']);
    const ext = createImageInputOptimizerExt.create(makeDeps({ config }));
    const tools = ext.getTools?.(makeModel({ inputCapabilities: {} }));
    expect(Object.keys(tools ?? {})).toEqual(['viewImage']);
  });

  it('returns empty toolset when model supports image input', () => {
    const config = makeVisionConfig(['vision:gpt-4o']);
    const ext = createImageInputOptimizerExt.create(makeDeps({ config }));
    const tools = ext.getTools?.(
      makeModel({ inputCapabilities: { image: DEFAULT_IMAGE_CAPS } }),
    );
    expect(tools).toEqual({});
  });

  it('returns empty toolset when model lacks image support but no vision models configured', () => {
    const ext = createImageInputOptimizerExt.create(makeDeps());
    const tools = ext.getTools?.(makeModel({ inputCapabilities: {} }));
    expect(tools).toEqual({});
  });

  it('returns empty toolset when vision models lack image capability', () => {
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'imageVision' ? ['vision:no-image-model'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {},
      })),
    } as unknown as ExtensionDeps['config'];
    const ext = createImageInputOptimizerExt.create(makeDeps({ config }));
    const tools = ext.getTools?.(makeModel({ inputCapabilities: {} }));
    expect(tools).toEqual({});
  });
});

describe('ImageInputOptimizer — viewImage tool execute', () => {
  /** Helper: creates an extension, runs the context transformer to register
   * an image, then returns the tool execute function. */
  async function setupToolAndImage(
    img: Buffer,
    deps: ExtensionDeps,
  ): Promise<(input: { id: string; lookFor: string }) => Promise<string>> {
    const ext = createImageInputOptimizerExt.create(deps);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const nonVisionModel = makeModel({ inputCapabilities: {} });
    await ext.contextTransformer?.([msg], nonVisionModel);
    const tools = ext.getTools?.(nonVisionModel) ?? {};
    const viewImage = tools.viewImage as {
      execute: (input: { id: string; lookFor?: string }) => Promise<string>;
    };
    return viewImage.execute as (input: {
      id: string;
      lookFor: string;
    }) => Promise<string>;
  }

  it('passes tool system prompt and image to generateText on tool execute', async () => {
    const img = await makeImageBuffer(100, 100);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndImage(img, deps);
    // Use lookFor to force a second generateText call (without lookFor,
    // the cached general description is returned and no new call is made)
    const result = await execute({ id: '0-0', lookFor: 'colors' });
    expect(result).toBe('A red square.');
    expect(generateText).toHaveBeenCalledTimes(2);
    const toolArgs = generateText.mock.calls[1]?.[0] as {
      modelIds: string[];
      system: string;
      messages: ModelMessage[];
    };
    expect(toolArgs.modelIds).toEqual(['vision:gpt-4o']);
    // Tool execute uses the tool prompt, not the general description prompt
    expect(toolArgs.system).toBe('Answer the question about the image.');
    expect(toolArgs.messages).toHaveLength(1);
    expect(toolArgs.messages[0]?.role).toBe('user');
    // First call (context transformation) uses the general description prompt
    const ctxArgs = generateText.mock.calls[0]?.[0] as { system: string };
    expect(ctxArgs.system).toBe('Describe this image.');
  });

  it('passes lookFor as additional text content when provided', async () => {
    const img = await makeImageBuffer(100, 100);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi
      .fn()
      .mockResolvedValue(genSuccess('It says hello.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndImage(img, deps);
    await execute({ id: '0-0', lookFor: 'text content' });
    // First call is the general description during context transformation,
    // second call is the targeted tool execute with lookFor.
    expect(generateText).toHaveBeenCalledTimes(2);
    const args = generateText.mock.calls[1]?.[0] as {
      messages: ModelMessage[];
    };
    const content = args.messages[0]?.content as Array<Record<string, unknown>>;
    // Should contain the image part and a text part with lookFor
    expect(content).toHaveLength(2);
    expect(content.some((p) => p.type === 'file' || p.type === 'image')).toBe(
      true,
    );
    const textPart = content.find((p) => p.type === 'text');
    expect(textPart).toBeDefined();
    expect(textPart?.text).toContain('text content');
  });

  it('returns error message for unknown image ID', async () => {
    const img = await makeImageBuffer(100, 100);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndImage(img, deps);
    const result = await execute({ id: '99-99', lookFor: 'test' });
    expect(result).toContain('not found');
    // generateText was called once during context transformation
    // (for the general description), but not for the unknown ID.
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('uses chat model fallback when vision models fail', async () => {
    const img = await makeImageBuffer(100, 100);
    const config = makeVisionConfig(
      ['vision:gpt-4o'],
      ['chat:claude-3'],
      ['chat:claude-3'],
    );
    const generateText = vi
      .fn()
      .mockResolvedValueOnce(genSuccess('General description.'))
      .mockResolvedValueOnce(genFailure())
      .mockResolvedValueOnce(genSuccess('Chat model description.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndImage(img, deps);
    const result = await execute({ id: '0-0', lookFor: 'details' });
    expect(result).toBe('Chat model description.');
    expect(generateText).toHaveBeenCalledTimes(3);
    const thirdCall = generateText.mock.calls[2]?.[0] as {
      modelIds: string[];
    };
    expect(thirdCall.modelIds).toEqual(['chat:claude-3']);
  });

  it('returns failure message when both vision and chat fallback fail', async () => {
    const img = await makeImageBuffer(100, 100);
    const config = makeVisionConfig(
      ['vision:gpt-4o'],
      ['chat:claude-3'],
      ['chat:claude-3'],
    );
    const generateText = vi.fn().mockResolvedValue(genFailure());
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndImage(img, deps);
    const result = await execute({ id: '0-0', lookFor: 'details' });
    expect(result).toContain('Unable to analyze');
  });

  it('skips chat fallback when no chat models have image capability', async () => {
    const img = await makeImageBuffer(100, 100);
    const config = {
      getModelSelection: vi.fn((p: string) => {
        if (p === 'imageVision') return ['vision:gpt-4o'];
        if (p === 'chat') return ['chat:text-only-model'];
        return [];
      }),
      resolveModelInfo: vi.fn((id: string) => {
        if (id === 'vision:gpt-4o') {
          return {
            contextSize: 128_000,
            displayName: undefined,
            inputCapabilities: { image: DEFAULT_IMAGE_CAPS },
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
    const execute = await setupToolAndImage(img, deps);
    const result = await execute({ id: '0-0', lookFor: 'details' });
    expect(result).toContain('Unable to analyze');
    // Called during context transformation and during tool execute
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('generates separate descriptions for different lookFor values', async () => {
    const img = await makeImageBuffer(100, 100);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi
      .fn()
      .mockResolvedValueOnce(genSuccess('General description.'))
      .mockResolvedValueOnce(genSuccess('Description for colors.'))
      .mockResolvedValueOnce(genSuccess('Description for text.'));
    const deps = makeDeps({ config, generateText });
    const execute = await setupToolAndImage(img, deps);
    const r1 = await execute({ id: '0-0', lookFor: 'colors' });
    const r2 = await execute({ id: '0-0', lookFor: 'text' });
    expect(r1).toBe('Description for colors.');
    expect(r2).toBe('Description for text.');
    // 3 calls: general description (context transformer) + 2 targeted
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it('reports descriptionCacheSize in introspect after tool call', async () => {
    const img = await makeImageBuffer(100, 100);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    const ext = createImageInputOptimizerExt.create(deps);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const nonVisionModel = makeModel({ inputCapabilities: {} });
    await ext.contextTransformer?.([msg], nonVisionModel);
    const tools = ext.getTools?.(nonVisionModel) ?? {};
    const viewImage = tools.viewImage as {
      execute: (input: { id: string; lookFor: string }) => Promise<string>;
    };
    await viewImage.execute?.({ id: '0-0', lookFor: 'test' }, {
      messages: [],
      toolCallId: 'test',
    } as never);
    const state = ext.introspect?.() as Record<string, unknown>;
    expect(state.descriptionCacheSize).toBe(1);
  });
});

describe('ImageInputOptimizer — vision helper image optimization', () => {
  it('optimizes image for the vision helper model before sending', async () => {
    // Large image (3000x3000) that exceeds the vision model's maxWidth of 500
    const img = await makeImageBuffer(3000, 3000, 'png');
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'imageVision' ? ['vision:gpt-4o'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {
          image: {
            mediaTypes: ['image/png'],
            maxBytes: 4_194_304,
            maxWidth: 500,
            maxHeight: 500,
          },
        },
      })),
    } as unknown as ExtensionDeps['config'];
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });

    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps);

    // The image passed to generateText should be resized to <=500x500
    const args = generateText.mock.calls[0]?.[0] as {
      messages: ModelMessage[];
    };
    const content = args.messages[0]?.content as Array<Record<string, unknown>>;
    const imagePart = content.find(
      (p) => p.type === 'file' || p.type === 'image',
    );
    expect(imagePart).toBeDefined();
    const data = extractFileData(
      imagePart as Record<string, unknown> | undefined,
    );
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBeLessThanOrEqual(500);
    expect(meta.height).toBeLessThanOrEqual(500);
  });

  it('caches optimized image for vision helper across calls', async () => {
    const img = await makeImageBuffer(3000, 3000, 'png');
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'imageVision' ? ['vision:gpt-4o'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {
          image: {
            mediaTypes: ['image/webp', 'image/png', 'image/jpeg'],
            maxBytes: 4_194_304,
            maxWidth: 500,
            maxHeight: 500,
          },
        },
      })),
    } as unknown as ExtensionDeps['config'];
    const generateText = vi
      .fn()
      .mockResolvedValueOnce(genSuccess('General.'))
      .mockResolvedValueOnce(genSuccess('Look for colors.'))
      .mockResolvedValueOnce(genSuccess('Look for text.'));
    const deps = makeDeps({ config, generateText });

    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const nonVisionModel = makeModel({ inputCapabilities: {} });
    const ext = createImageInputOptimizerExt.create(deps);
    // Context transformer generates general description (call 1)
    await ext.contextTransformer?.([msg], nonVisionModel);
    const tools = ext.getTools?.(nonVisionModel) ?? {};
    const execute = tools.viewImage?.execute as (input: {
      id: string;
      lookFor?: string;
    }) => Promise<string>;

    // Two targeted tool calls with different lookFor — each triggers
    // describeImage (calls 2 and 3), but the image passed to the vision
    // model should be the same cached optimized object.
    await execute({ id: '0-0', lookFor: 'colors' });
    await execute({ id: '0-0', lookFor: 'text' });

    const args1 = generateText.mock.calls[1]?.[0] as {
      messages: ModelMessage[];
    };
    const args2 = generateText.mock.calls[2]?.[0] as {
      messages: ModelMessage[];
    };
    const img1 = (
      (args1.messages[0] as ModelMessage).content as Array<
        Record<string, unknown>
      >
    ).find((p) => p.type === 'file');
    const img2 = (
      (args2.messages[0] as ModelMessage).content as Array<
        Record<string, unknown>
      >
    ).find((p) => p.type === 'file');
    // Same cached object reference — image was only optimized once
    expect(img1).toBe(img2);
  });

  it('passes image through unchanged when vision model has no constraints', async () => {
    const img = await makeImageBuffer(100, 100, 'png');
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'imageVision' ? ['vision:gpt-4o'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {
          image: {
            mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
            maxBytes: 4_194_304,
          },
        },
      })),
    } as unknown as ExtensionDeps['config'];
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });

    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps);

    const args = generateText.mock.calls[0]?.[0] as {
      messages: ModelMessage[];
    };
    const content = args.messages[0]?.content as Array<Record<string, unknown>>;
    const imagePart = content.find((p) => p.type === 'file');
    // Image is within all limits — should be passed through as-is
    const data = extractFileData(
      imagePart as Record<string, unknown> | undefined,
    );
    expect(Buffer.from(data, 'base64')).toEqual(img);
  });

  it('converts format for vision helper when format not supported', async () => {
    // Vision model only supports png, image is webp
    const img = await makeImageBuffer(100, 100, 'webp');
    const config = {
      getModelSelection: vi.fn((p: string) =>
        p === 'imageVision' ? ['vision:gpt-4o'] : [],
      ),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {
          image: {
            mediaTypes: ['image/png'],
            maxBytes: 4_194_304,
          },
        },
      })),
    } as unknown as ExtensionDeps['config'];
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });

    const msg = makeUserMessage([makeFilePart(img, 'image/webp')]);
    await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps);

    const args = generateText.mock.calls[0]?.[0] as {
      messages: ModelMessage[];
    };
    const content = args.messages[0]?.content as Array<Record<string, unknown>>;
    const imagePart = content.find((p) => p.type === 'file');
    expect(imagePart?.mediaType).toBe('image/png');
    const data = extractFileData(
      imagePart as Record<string, unknown> | undefined,
    );
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.format).toBe('png');
  });
});

// --- BoundedCache tests ---

describe('BoundedCache', () => {
  it('evicts oldest entries when size limit is exceeded', () => {
    const c = new BoundedCache<string, string>(10, (v) => v.length);
    c.set('a', '1234'); // 4 bytes
    c.set('b', '1234'); // 8 bytes total
    c.set('c', '1234'); // 12 bytes — exceeds 10, evicts 'a'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe('1234');
    expect(c.get('c')).toBe('1234');
    expect(c.size).toBe(2);
  });

  it('does not evict the last remaining entry even if it exceeds the limit', () => {
    const c = new BoundedCache<string, string>(5, (v) => v.length);
    c.set('x', '123456789'); // 9 bytes, exceeds 5 but only one entry
    expect(c.get('x')).toBe('123456789');
    expect(c.size).toBe(1);
  });

  it('replaces existing key and adjusts size', () => {
    const c = new BoundedCache<string, string>(20, (v) => v.length);
    c.set('a', 'hello'); // 5 bytes
    c.set('b', 'world'); // 10 bytes total
    c.set('a', 'hi'); // replaces, total = 2 + 5 = 7 bytes
    expect(c.get('a')).toBe('hi');
    expect(c.get('b')).toBe('world');
    expect(c.size).toBe(2);
  });

  it('clears all entries', () => {
    const c = new BoundedCache<string, string>(100, (v) => v.length);
    c.set('a', 'x');
    c.set('b', 'y');
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });
});

// --- Default media types fallback ---

describe('default media types fallback', () => {
  beforeEach(() => {
    clearImageInputOptimizerCache();
  });

  it('falls back to webp/png/jpeg when model has image but no mediaTypes configured', async () => {
    // Create a TIFF image — not in the default set, so it must be converted
    const img = await sharp({
      create: { width: 100, height: 100, channels: 3, background: 'red' },
    })
      .toFormat('tiff')
      .toBuffer();
    const model = makeModel({
      inputCapabilities: {
        image: { maxBytes: 4_194_304 } as unknown as {
          mediaTypes: string[];
          maxBytes: number;
        },
      },
    });
    const msg = makeUserMessage([makeFilePart(img, 'image/tiff')]);
    const result = await runTransformer([msg], model);
    const content = getContent(result, 0);
    // TIFF should be converted to one of the default formats
    const imagePart = content.find(
      (p) => p.type === 'file',
    ) as unknown as FilePart;
    expect(imagePart).toBeDefined();
    expect(
      ['image/webp', 'image/png', 'image/jpeg'].includes(imagePart.mediaType),
    ).toBe(true);
  });

  it('falls back to defaults when mediaTypes is an empty array', async () => {
    // Create a TIFF image — not in the default set, so it must be converted
    const img = await sharp({
      create: { width: 100, height: 100, channels: 3, background: 'red' },
    })
      .toFormat('tiff')
      .toBuffer();
    const model = makeModel({
      inputCapabilities: {
        image: { mediaTypes: [], maxBytes: 4_194_304 } as unknown as {
          mediaTypes: string[];
          maxBytes: number;
        },
      },
    });
    const msg = makeUserMessage([makeFilePart(img, 'image/tiff')]);
    const result = await runTransformer([msg], model);
    const content = getContent(result, 0);
    const imagePart = content.find(
      (p) => p.type === 'file',
    ) as unknown as FilePart;
    expect(imagePart).toBeDefined();
    expect(
      ['image/webp', 'image/png', 'image/jpeg'].includes(imagePart.mediaType),
    ).toBe(true);
  });
});

// --- Assistant and tool message image processing ---

describe('processes images in non-user messages', () => {
  beforeEach(() => {
    clearImageInputOptimizerCache();
  });

  it('processes image FileParts in assistant messages', async () => {
    const img = await makeImageBuffer(2000, 2000, 'png');
    const model = makeModel({
      inputCapabilities: { image: DEFAULT_IMAGE_CAPS },
    });
    const msg: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Here is a generated image:' },
        makeFilePart(img, 'image/png'),
      ],
    };
    const result = await runTransformer([msg], model);
    const content = (result[0] as ModelMessage).content as Array<
      Record<string, unknown>
    >;
    const imagePart = content.find(
      (p) => p.type === 'file',
    ) as unknown as FilePart;
    expect(imagePart).toBeDefined();
    // Should be resized to fit within 2048x2048
    const data = (imagePart.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      2048,
    );
  });

  it('processes image file items in tool-result content outputs', async () => {
    const img = await makeImageBuffer(2000, 2000, 'png');
    const model = makeModel({
      inputCapabilities: { image: DEFAULT_IMAGE_CAPS },
    });
    const toolResultPart: ToolResultPart = {
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'generateImage',
      output: {
        type: 'content',
        value: [
          {
            type: 'file',
            data: { type: 'data', data: img },
            mediaType: 'image/png',
          },
        ],
      },
    };
    const msg: ModelMessage = {
      role: 'tool',
      content: [toolResultPart],
    };
    const result = await runTransformer([msg], model);
    const content = (result[0] as ModelMessage)
      .content as Array<ToolResultPart>;
    const output = (content[0] as ToolResultPart).output as {
      type: 'content';
      value: Array<Record<string, unknown>>;
    };
    expect(output.type).toBe('content');
    const fileItem = output.value.find(
      (i) => i.type === 'file',
    ) as unknown as Record<string, unknown>;
    expect(fileItem).toBeDefined();
    const data = (fileItem.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      2048,
    );
  });
});

import type { FilePart, ModelMessage, UserContent } from 'ai';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionDeps, ResolvedModel } from '../extension-api';
import {
  clearVisionInputOptimizerCache,
  createVisionInputOptimizerExt,
} from './vision-input-optimizer';

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
    config: {} as ExtensionDeps['config'],
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
  const msg = result[msgIndex]!;
  return msg.content as unknown as Array<Record<string, unknown>>;
}

async function runTransformer(
  history: ModelMessage[],
  model: ResolvedModel,
  deps?: ExtensionDeps,
): Promise<ModelMessage[]> {
  const ext = createVisionInputOptimizerExt.create(deps ?? makeDeps());
  const result = await ext.contextTransformer!(history, model);
  return Array.isArray(result)
    ? result
    : (result as { history: ModelMessage[] }).history;
}

// --- tests ---

beforeEach(() => {
  vi.clearAllMocks();
  clearVisionInputOptimizerCache();
});

describe('VisionInputOptimizer — image detection', () => {
  it('detects FilePart with image/png mediaType', async () => {
    const img = await makeImageBuffer(50, 50);
    const msg = makeUserMessage([
      { type: 'text', text: 'hello' },
      makeFilePart(img, 'image/png'),
    ]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]!.type).toBe('text');
    expect(content[1]!.type).toBe('file');
  });

  it('detects FilePart with bare image mediaType', async () => {
    const img = await makeImageBuffer(50, 50);
    const msg = makeUserMessage([makeFilePart(img, 'image')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]!.type).toBe('file');
  });

  it('detects deprecated ImagePart', async () => {
    const img = await makeImageBuffer(50, 50);
    const msg = makeUserMessage([{ type: 'image', image: img }]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    // ImagePart with inline data gets normalized to FilePart
    expect(content[0]!.type).toBe('file');
  });

  it('leaves non-image FilePart untouched', async () => {
    const msg = makeUserMessage([
      makeFilePart(Buffer.from('not-an-image'), 'application/pdf'),
    ]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]!.type).toBe('file');
    expect(content[0]!.mediaType).toBe('application/pdf');
  });

  it('leaves TextPart untouched', async () => {
    const msg = makeUserMessage([{ type: 'text', text: 'hello' }]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]!.type).toBe('text');
    expect(content[0]!.text).toBe('hello');
  });
});

describe('VisionInputOptimizer — URL images skipped', () => {
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
    expect(content[0]!.type).toBe('file');
    expect(content[0]!.mediaType).toBe('image/webp');
  });
});

describe('VisionInputOptimizer — no transformation needed', () => {
  it('returns image as-is when within all limits', async () => {
    const img = await makeImageBuffer(100, 100);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]!.type).toBe('file');
    const data = content[0]!.data as { type: string; data: string };
    expect(data.type).toBe('data');
    expect(typeof data.data).toBe('string');
    // Verify it's valid base64 by decoding round-trip
    expect(Buffer.from(data.data, 'base64').length).toBeGreaterThan(0);
  });
});

describe('VisionInputOptimizer — metadata stripping', () => {
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
    const outputBuffer = (content[0]!.data as { data: string }).data;
    const outputMeta = await sharp(
      Buffer.from(outputBuffer, 'base64'),
    ).metadata();
    expect(outputMeta.exif).toBeUndefined();
    expect(outputMeta.iptc).toBeUndefined();
    expect(outputMeta.xmp).toBeUndefined();
    expect(outputMeta.icc).toBeUndefined();
  });
});

describe('VisionInputOptimizer — resize enforcement', () => {
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
    const data = (content[0]!.data as { data: string }).data;
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
    const data = (content[0]!.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.height).toBeLessThanOrEqual(500);
  });
});

describe('VisionInputOptimizer — aspect ratio preservation', () => {
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
    const data = (content[0]!.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(50);
    // Aspect ratio preserved: 400/50 === 800/100 === 8
    expect(meta.width! / meta.height!).toBeCloseTo(8, 5);
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
    const data = (content[0]!.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBe(25);
    expect(meta.height).toBe(100);
    expect(meta.width! / meta.height!).toBeCloseTo(0.25, 5);
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
    const data = (content[0]!.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    const ratio = meta.width! / meta.height!;
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
    const data = (content[0]!.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBeLessThanOrEqual(300);
    expect(meta.height).toBeLessThanOrEqual(200);
    expect(meta.width! / meta.height!).toBeCloseTo(3, 1);
  });
});

describe('VisionInputOptimizer — maxTotalPixels enforcement', () => {
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
    const data = (content[0]!.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect((meta.width ?? 0) * (meta.height ?? 0)).toBeLessThanOrEqual(500_000);
  });
});

describe('VisionInputOptimizer — maxDataSize enforcement', () => {
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
    const data = (content[0]!.data as { data: string }).data;
    expect(Buffer.from(data, 'base64').length).toBeLessThanOrEqual(10_000);
  });
});

describe('VisionInputOptimizer — format preference', () => {
  it('prefers webp when webp is in mediaTypes', async () => {
    const img = await makeImageBuffer(3000, 3000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]!.mediaType).toBe('image/webp');
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
    expect(content[0]!.mediaType).toBe('image/png');
  });
});

describe('VisionInputOptimizer — supports: false', () => {
  it('replaces image with TextPart notification', async () => {
    const img = await makeImageBuffer(100, 100);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} })),
      0,
    );
    expect(content[0]!.type).toBe('text');
    expect(content[0]!.text).toBe(
      "Can't see this image. Vision isn't supported.",
    );
  });

  it('caches the TextPart replacement', async () => {
    const img = await makeImageBuffer(100, 100);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const model = makeModel({ inputCapabilities: {} });
    const result1 = await runTransformer([msg], model);
    const result2 = await runTransformer([msg], model);
    const c1 = getContent(result1, 0);
    const c2 = getContent(result2, 0);
    expect(c1[0]!.text).toBe(c2[0]!.text);
  });
});

describe('VisionInputOptimizer — caching', () => {
  it('returns cached result on second call with same image + modelId', async () => {
    const img = await makeImageBuffer(3000, 3000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const model = makeModel();

    const result1 = await runTransformer([msg], model);
    const result2 = await runTransformer([msg], model);
    const c1 = getContent(result1, 0);
    const c2 = getContent(result2, 0);

    // Same object from cache
    expect(c1[0]).toBe(c2[0]);
  });

  it('shares cache across extension instances', async () => {
    const img = await makeImageBuffer(3000, 3000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const model = makeModel();

    const deps = makeDeps();
    const ext1 = createVisionInputOptimizerExt.create(deps);
    const ext2 = createVisionInputOptimizerExt.create(deps);

    const r1 = await ext1.contextTransformer!([msg], model);
    const r2 = await ext2.contextTransformer!([msg], model);
    const arr1 = Array.isArray(r1)
      ? r1
      : (r1 as { history: ModelMessage[] }).history;
    const arr2 = Array.isArray(r2)
      ? r2
      : (r2 as { history: ModelMessage[] }).history;
    const c1 = arr1[0]!.content as unknown as Array<Record<string, unknown>>;
    const c2 = arr2[0]!.content as unknown as Array<Record<string, unknown>>;

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

describe('VisionInputOptimizer — multiple images and messages', () => {
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
    expect(content[0]!.type).toBe('file');
    expect(content[1]!.type).toBe('text');
    expect(content[2]!.type).toBe('file');
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
    expect(c1[0]!.type).toBe('file');
    expect(c2[0]!.type).toBe('text');
    expect(c2[1]!.type).toBe('file');
  });
});

describe('VisionInputOptimizer — format-only conversion (no resize needed)', () => {
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
    expect(content[0]!.mediaType).toBe('image/png');
    const data = (content[0]!.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.format).toBe('png');
    // Dimensions preserved — no resize happened
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
  });
});

describe('VisionInputOptimizer — graceful degradation on unparseable image', () => {
  it('replaces corrupt image with text notification on sharp error', async () => {
    const corruptBuffer = Buffer.from('not-a-real-image-just-bytes');
    const msg = makeUserMessage([makeFilePart(corruptBuffer, 'image/png')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    expect(content[0]!.type).toBe('text');
    expect(content[0]!.text).toBe(
      "Can't see this image. Vision isn't supported.",
    );
  });
});

describe('VisionInputOptimizer — defaults', () => {
  it('applies default constraints when maxWidth/maxHeight not specified', async () => {
    const img = await makeImageBuffer(500, 500);
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    const data = (content[0]!.data as { data: string }).data;
    expect(Buffer.from(data, 'base64')).toEqual(img);
  });

  it('applies default maxWidth when maxWidth not specified', async () => {
    const img = await makeImageBuffer(3000, 100, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(await runTransformer([msg], makeModel()), 0);
    const data = (content[0]!.data as { data: string }).data;
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    expect(meta.width).toBeLessThanOrEqual(2048);
  });
});

describe('VisionInputOptimizer — introspection', () => {
  it('reports cache size via introspect()', async () => {
    const ext = createVisionInputOptimizerExt.create(makeDeps());
    expect(ext.introspect!()).toEqual({ cacheSize: 0 });

    const img = await makeImageBuffer(3000, 3000, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    await ext.contextTransformer!([msg], makeModel());

    expect(ext.introspect!()).toEqual({ cacheSize: 1 });
  });
});

describe('VisionInputOptimizer — non-image content preserved', () => {
  it('does not modify text parts or non-image file parts', async () => {
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

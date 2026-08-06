import type { FilePart, ModelMessage, ToolResultPart } from 'ai';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BoundedCache,
  createImageInputOptimizerExt,
} from './image-input-optimizer';
import {
  clearImageInputOptimizerCache,
  DEFAULT_IMAGE_CAPS,
  extractFileData,
  getContent,
  makeDeps,
  makeFilePart,
  makeImageBuffer,
  makeModel,
  makeUserMessage,
  makeVisionConfig,
  runTransformer,
} from './test-helpers';

vi.mock('./vision-system-prompt.md', () => ({
  default: 'Describe this image.',
}));

vi.mock('./vision-tool-system-prompt.md', () => ({
  default: 'Answer the question about the image.',
}));

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

  it('replaces URL image with placeholder for non-vision models with vision helpers', async () => {
    const part: FilePart = {
      type: 'file',
      data: { type: 'url', url: new URL('https://example.com/image.png') },
      mediaType: 'image/png',
    };
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn();
    const deps = makeDeps({ config, generateText });
    const msg = makeUserMessage([part]);
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} }), deps),
      0,
    );
    // URL image can't be extracted for description generation —
    // should be replaced with placeholder text, not passed through.
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain("Can't directly see image");
    expect(content[0]?.text).toContain('viewImage');
    // generateText should NOT be called — no inline buffer to describe
    expect(generateText).not.toHaveBeenCalled();
  });

  it('replaces URL image with unsupported text for non-vision models without vision helpers', async () => {
    const part: FilePart = {
      type: 'file',
      data: { type: 'url', url: new URL('https://example.com/image.png') },
      mediaType: 'image/png',
    };
    const msg = makeUserMessage([part]);
    const content = getContent(
      await runTransformer([msg], makeModel({ inputCapabilities: {} })),
      0,
    );
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(
      "Can't see the image, you have no vision capabilities or vision model as a helper to see the image.",
    );
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

  it('uses declared non-standard format instead of defaulting to webp', async () => {
    // Model only supports gif — should convert to gif, not webp
    const img = await makeImageBuffer(100, 100, 'png');
    const msg = makeUserMessage([makeFilePart(img, 'image/png')]);
    const content = getContent(
      await runTransformer(
        [msg],
        makeModel({
          inputCapabilities: {
            image: {
              mediaTypes: ['image/gif'],
              maxBytes: 4_194_304,
            },
          },
        }),
      ),
      0,
    );
    expect(content[0]?.type).toBe('file');
    expect(content[0]?.mediaType).toBe('image/gif');
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

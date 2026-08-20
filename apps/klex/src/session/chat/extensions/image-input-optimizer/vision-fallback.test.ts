import type { ModelMessage } from 'ai';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionDeps } from '../extension-api';
import {
  clearImageInputOptimizerCache,
  createImageInputOptimizerExt,
  DEFAULT_IMAGE_CAPS,
  extractFileData,
  genFailure,
  genSuccess,
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

  it('deduplicates concurrent requests for identical images', async () => {
    const img = await makeImageBuffer(100, 100);
    // Two identical images in the same message
    const msg = makeUserMessage([
      makeFilePart(img, 'image/png'),
      makeFilePart(img, 'image/png'),
    ]);
    const config = makeVisionConfig(['vision:gpt-4o']);
    const generateText = vi.fn().mockResolvedValue(genSuccess('A red square.'));
    const deps = makeDeps({ config, generateText });
    const model = makeModel({ inputCapabilities: {} });

    const content = getContent(await runTransformer([msg], model, deps), 0);

    // Both images should get descriptions
    expect(content[0]?.type).toBe('text');
    expect(content[1]?.type).toBe('text');
    // generateText should be called only once — in-flight dedup
    // prevents the second concurrent request from firing.
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
    const viewImage = tools.viewImage as unknown as {
      execute: (
        input: { id: string; lookFor?: string },
        options?: unknown,
      ) => Promise<string>;
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
    const viewImage = tools.viewImage as unknown as {
      execute: (
        input: { id: string; lookFor: string },
        options?: unknown,
      ) => Promise<string>;
    };
    await viewImage.execute({ id: '0-0', lookFor: 'test' }, {
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

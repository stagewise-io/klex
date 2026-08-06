import type { FilePart, ModelMessage, UserContent } from 'ai';
import sharp from 'sharp';
import { vi } from 'vitest';

import type { ExtensionDeps, ResolvedModel } from '../extension-api';
import {
  clearImageInputOptimizerCache,
  createImageInputOptimizerExt,
} from './image-input-optimizer';

export function makeDeps(overrides?: Partial<ExtensionDeps>): ExtensionDeps {
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
    router: { sendInput: vi.fn() } as unknown as ExtensionDeps['router'],
    sessionId: 'test-session',
    getDataDir: vi.fn(() => '/tmp/test-ext-data'),
    ...overrides,
  };
}

export const DEFAULT_IMAGE_CAPS = {
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxBytes: 4_194_304,
};

export function makeModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
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

export async function makeImageBuffer(
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

export function makeFilePart(
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

export function makeUserMessage(content: UserContent): ModelMessage {
  return { role: 'user', content };
}

/** Extracts the content array from a transformed user message. */
export function getContent(
  result: ModelMessage[],
  msgIndex: number,
): Array<Record<string, unknown>> {
  const msg = result[msgIndex] as ModelMessage;
  return msg.content as unknown as Array<Record<string, unknown>>;
}

/** Extracts the base64 data string from a file part's data field. */
export function extractFileData(
  part: Record<string, unknown> | undefined,
): string {
  const data = part?.data as { data: string } | undefined;
  return data?.data ?? '';
}

export async function runTransformer(
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
export function genSuccess(text: string): {
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
export function genFailure(): {
  success: false;
  failureReason: 'all-models-failed';
} {
  return { success: false, failureReason: 'all-models-failed' };
}

/** Config mock that returns vision models with image capability. */
export function makeVisionConfig(
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

export { clearImageInputOptimizerCache, createImageInputOptimizerExt };

import type { FilePart, ModelMessage } from 'ai';
import sharp from 'sharp';
import { vi } from 'vitest';

import {
  extractFileData,
  genFailure,
  genSuccess,
  getContent,
  makeDeps,
  makeUserMessage,
  makeFilePart as sharedMakeFilePart,
  makeModel as sharedMakeModel,
  runTransformer as sharedRunTransformer,
} from '@/shared-utilities';

import type { ExtensionDeps, ResolvedModel } from '../extension-api';
import {
  clearImageInputOptimizerCache,
  createImageInputOptimizerExt,
} from './image-input-optimizer';

export {
  extractFileData,
  genFailure,
  genSuccess,
  getContent,
  makeDeps,
  makeUserMessage,
};

export const DEFAULT_IMAGE_CAPS = {
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxBytes: 4_194_304,
};

export function makeModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return sharedMakeModel({ image: DEFAULT_IMAGE_CAPS }, overrides);
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
  return sharedMakeFilePart(buffer, mediaType, filename);
}

export async function runTransformer(
  history: ModelMessage[],
  model: ResolvedModel,
  deps?: ExtensionDeps,
): Promise<ModelMessage[]> {
  return sharedRunTransformer(
    history,
    model,
    createImageInputOptimizerExt,
    deps,
  );
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

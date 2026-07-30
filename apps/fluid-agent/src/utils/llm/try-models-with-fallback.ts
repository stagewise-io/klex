import type { LanguageModelV4 } from '@ai-sdk/provider';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';

/**
 * Tries each model in order, returning the first successful result.
 *
 * @param modelIds   Ordered list of model IDs to try.
 * @param modelProvider  Provider used to resolve each model ID.
 * @param fn         Async function called with each resolved model and its
 *                   model ID. The first non-throwing call wins.
 * @param opts.logger  Logger for warning/error messages on failures.
 * @param opts.label    Short label included in log messages (e.g. `"compression"`).
 * @returns The result of the first successful `fn` call, or `null` if all
 *          models failed.
 */
export async function tryModelsWithFallback<T>(
  modelIds: readonly ModelId[],
  modelProvider: ModelProvider,
  fn: (model: LanguageModelV4, modelId: ModelId) => Promise<T>,
  opts: {
    logger: ModuleLogger;
    label: string;
  },
): Promise<T | null> {
  for (const modelId of modelIds) {
    try {
      const model = await modelProvider.get(modelId);
      return await fn(model, modelId);
    } catch (error) {
      opts.logger.warn(
        { error, modelId },
        `${opts.label} model failed — trying next`,
      );
    }
  }

  opts.logger.error(`All models failed for ${opts.label}`);
  return null;
}

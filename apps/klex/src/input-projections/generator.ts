import type { ModelSelectionEntry } from '@/config';
import type {
  GenerateTextArgs,
  GenerateTextResult,
} from '@/session/chat/extensions/extension-api';

import { limits } from './bounds';
import {
  type Catalog,
  type CatalogField,
  compile,
  type Plan,
  selectionSchema,
} from './catalog';
import systemPrompt from './system-prompt.md';

export interface GenerationOptions {
  generate: (args: GenerateTextArgs) => Promise<GenerateTextResult>;
  modelIds: readonly ModelSelectionEntry[];
  identity?: readonly CatalogField[];
  signal?: AbortSignal;
  deadlineMs?: number;
}
/** A tool-free, two-attempt classification within one hard wall-clock deadline. */
export async function generatePlan(
  input: Catalog,
  options: GenerationOptions,
  review?: { current: Plan; reasons: readonly string[] },
): Promise<Plan | undefined> {
  if (
    !input.complete ||
    input.fields.length > 128 ||
    !options.modelIds.length ||
    options.signal?.aborted
  )
    return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, options.deadlineMs ?? limits.preparationMs);
    controller.signal.addEventListener('abort', () => resolve(undefined), {
      once: true,
    });
  });
  const work = async (): Promise<Plan | undefined> => {
    for (
      let attempt = 0;
      attempt < 2 && !controller.signal.aborted;
      attempt++
    ) {
      try {
        const fields = input.fields.map(({ path, type, sample }) => ({
          path,
          type,
          sample,
        }));
        const prompt = JSON.stringify({
          fields,
          ...(options.identity ? { identity: options.identity } : {}),
          ...(review
            ? {
                review: {
                  reasons: review.reasons,
                  current: {
                    keep: review.current.fields
                      .filter(({ keep }) => keep)
                      .map(({ path }) => path),
                  },
                },
              }
            : {}),
        });
        if (Buffer.byteLength(prompt) > 24_576) return undefined;
        const result = await options.generate({
          modelIds: options.modelIds,
          system: systemPrompt,
          prompt: `${attempt ? 'Previous output invalid. Return only a keep list of unique exact catalog paths as arrays of key segments.\n' : ''}${prompt}`,
          outputSchema: selectionSchema,
          maxOutputTokens: 4_096,
          maxRetries: 0,
          abortSignal: controller.signal,
        });
        if (controller.signal.aborted) return undefined;
        if (!result.success) return undefined;
        if (result.finishReason === 'length') continue;
        return compile(input, result.output);
      } catch {
        // Do not expose model output, sample text or provider errors in diagnostics.
      }
    }
    return undefined;
  };
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

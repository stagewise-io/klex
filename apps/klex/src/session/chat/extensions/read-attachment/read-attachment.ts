import type { ModelMessage, ToolSet } from 'ai';
import z from 'zod';

import {
  prepareRemoteInput,
  remoteInputModelOutput,
  remoteInputUnavailable,
} from '@/provider-registry/remote-input';

import type { ExtensionFactory, ResolvedModel } from '../extension-api';

const remoteFileSchema = z.object({
  type: z.literal('content'),
  value: z.tuple([
    z.object({
      type: z.literal('file'),
      mediaType: z.string(),
      data: z.object({ type: z.literal('url'), url: z.string() }),
    }),
  ]),
});

export const createReadAttachmentExt: ExtensionFactory = {
  identifier: 'io.klex/read-attachment',
  displayName: 'read-attachment',
  create: (deps) => {
    const prepare = async (
      model: ResolvedModel,
      input: { url: string; mediaType?: string },
    ) => {
      try {
        if (!model.reference) return remoteInputUnavailable();
        return await prepareRemoteInput(
          deps.modelResolver.getLanguageModel(model.reference),
          model.inputCapabilities,
          input,
        );
      } catch {
        return remoteInputUnavailable();
      }
    };
    return {
      getTools: (model): ToolSet => ({
        readAttachment: {
          description:
            'Supply remote media to the current model on the next turn. Pass the HTTP(S) URL and a media type known from trustworthy source metadata. Do not guess from the URL or filename. Missing or unsupported media types return unavailable. This tool never downloads media.',
          inputSchema: z.object({
            url: z.string(),
            mediaType: z.string().optional(),
          }),
          execute: (input) => prepare(model, input),
        },
      }),
      // UI tool outputs are JSON in canonical history. Reconstitute only this
      // tool's pending remote files and recheck the *current* model after model changes.
      // This runs before generation, so unsupported URLs cannot trigger SDK downloads.
      contextTransformer: async (history, model): Promise<ModelMessage[]> => {
        // Conversion separates an assistant's calls from their tool results.
        // A later assistant message means another generation has consumed those
        // results. User messages cannot define this boundary: provisional step
        // context and incoming events can follow the still-pending results.
        // Derive eligibility afresh so retries/model fallback revalidate the
        // same pending batch without consuming it during context preparation.
        const lastAssistant = history.findLastIndex(
          (message) => message.role === 'assistant',
        );
        return Promise.all(
          history.map(async (message, index) => {
            if (message.role !== 'tool') return message;
            return {
              ...message,
              content: await Promise.all(
                message.content.map(async (part) => {
                  if (
                    part.type !== 'tool-result' ||
                    part.toolName !== 'readAttachment'
                  )
                    return part;
                  const parsed = remoteFileSchema.safeParse(
                    part.output.type === 'json'
                      ? part.output.value
                      : part.output,
                  );
                  const file = parsed.success
                    ? parsed.data.value[0]
                    : undefined;
                  const result =
                    file && index > lastAssistant
                      ? await prepare(model, {
                          url: file.data.url,
                          mediaType: file.mediaType,
                        })
                      : remoteInputUnavailable();
                  return { ...part, output: remoteInputModelOutput(result) };
                }),
              ),
            };
          }),
        );
      },
    };
  },
};

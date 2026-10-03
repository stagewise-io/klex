import type { ModelMessage, ToolSet } from 'ai';
import z from 'zod';

import {
  prepareRemoteInput,
  remoteInputModelOutput,
  remoteInputRejected,
  remoteInputUnavailable,
} from '@/provider-registry/remote-input';
import { CONTEXT_SUMMARY_KEY } from '@/session/chat/utils/history-view';

import {
  type ExtensionFactory,
  isDataPartOf,
  type ResolvedModel,
} from '../extension-api';

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
    // Degrade state for provider-rejected media, keyed by toolCallId.
    // `injected` holds files sent with the most recent generation attempt;
    // when that step reports `requestRejected`, they move to `rejected` and
    // are replaced by an error-text output from then on. In-memory only: after
    // a restart there is at most one more rejected attempt before the file is
    // degraded again. Persisted history is never rewritten.
    const injected = new Set<string>();
    const rejected = new Set<string>();
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
            'Supply remote media to the current model on the next turn. Pass the HTTP(S) URL; optionally provide a mediaType from trustworthy source metadata, which takes precedence. When omitted, the tool infers a hint from a small allowlist of common image, PDF, audio, and video filename extensions (case-insensitive, ignoring query and fragment). Unknown extensions or unsupported media/URLs return unavailable. Inferred types still require model/provider support. This tool never downloads media.',
          inputSchema: z.object({
            url: z.string(),
            mediaType: z.string().optional(),
          }),
          execute: (input) => prepare(model, input),
        },
      }),
      historyTransformer: (history) => {
        // Canonical history retains the summary data-part marker; conversion
        // turns it into assistant text, indistinguishable from a generation.
        // Only a subsequent non-summary assistant consumes the pending batch.
        // User/provisional context and asynchronous summaries do not consume it.
        const lastGeneration = history.findLastIndex(
          (message) =>
            message.role === 'assistant' &&
            !message.parts.some((part) =>
              isDataPartOf(CONTEXT_SUMMARY_KEY, part),
            ),
        );
        return history.map((message, index) =>
          index >= lastGeneration
            ? message
            : {
                ...message,
                parts: message.parts.map((part) =>
                  part.type === 'dynamic-tool' &&
                  part.toolName === 'readAttachment' &&
                  part.state === 'output-available'
                    ? { ...part, output: remoteInputUnavailable() }
                    : part,
                ),
              },
        );
      },
      // UI tool outputs are JSON in canonical history. Reconstitute only this
      // tool's pending remote files and recheck the *current* model after model changes.
      // This runs before generation, so unsupported URLs cannot trigger SDK downloads.
      contextTransformer: async (history, model): Promise<ModelMessage[]> => {
        injected.clear();
        return Promise.all(
          history.map(async (message) => {
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
                  if (rejected.has(part.toolCallId)) {
                    return {
                      ...part,
                      output: remoteInputModelOutput(remoteInputRejected()),
                    };
                  }
                  const parsed = remoteFileSchema.safeParse(
                    part.output.type === 'json'
                      ? part.output.value
                      : part.output,
                  );
                  const file = parsed.success
                    ? parsed.data.value[0]
                    : undefined;
                  const result = file
                    ? await prepare(model, {
                        url: file.data.url,
                        mediaType: file.mediaType,
                      })
                    : remoteInputUnavailable();
                  if (result.type === 'content') injected.add(part.toolCallId);
                  return { ...part, output: remoteInputModelOutput(result) };
                }),
              ),
            };
          }),
        );
      },
      onStepComplete: (event) => {
        if (event.requestRejected) {
          for (const id of injected) rejected.add(id);
        }
        injected.clear();
      },
      introspect: () => ({
        injectedCount: injected.size,
        rejectedCount: rejected.size,
      }),
    };
  },
};

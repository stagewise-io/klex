import { isDeepStrictEqual } from 'node:util';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
  JSONObject,
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';

import type { ProviderInstance } from '../provider-registry';
import { isRecord, providerHeaders, setting } from './shared';

const SKIP_SIGNATURE = 'skip_thought_signature_validator';

function details(value: unknown): JSONObject[] {
  return Array.isArray(value) ? (value.filter(isRecord) as JSONObject[]) : [];
}

function responseMessage(
  value: unknown,
  key: 'message' | 'delta',
): Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.choices)) return {};
  const choice = value.choices[0];
  return isRecord(choice) && isRecord(choice[key]) ? choice[key] : {};
}

function metadata(
  existing: SharedV4ProviderMetadata | undefined,
  accumulated: JSONObject[],
): SharedV4ProviderMetadata | undefined {
  return accumulated.length
    ? {
        ...existing,
        openrouter: {
          ...existing?.openrouter,
          reasoning_details: structuredClone(accumulated),
        },
      }
    : existing;
}

function reasoningText(entries: JSONObject[]): string {
  return entries
    .map((entry) =>
      entry.type === 'reasoning.text' && typeof entry.text === 'string'
        ? entry.text
        : entry.type === 'reasoning.summary' &&
            typeof entry.summary === 'string'
          ? entry.summary
          : '',
    )
    .join('');
}

function accumulate(target: JSONObject[], entries: JSONObject[]) {
  for (const entry of entries) {
    const previous = target.at(-1);
    const field =
      entry.type === 'reasoning.text'
        ? 'text'
        : entry.type === 'reasoning.summary'
          ? 'summary'
          : undefined;
    if (
      field &&
      previous &&
      previous.type === entry.type &&
      ['id', 'index', 'format'].every(
        (key) =>
          previous[key] == null ||
          entry[key] == null ||
          previous[key] === entry[key],
      )
    ) {
      target[target.length - 1] = {
        ...previous,
        ...entry,
        [field]: `${previous[field] ?? ''}${entry[field] ?? ''}`,
      };
    } else target.push({ ...entry });
  }
}

function restoreMessages(
  args: Record<string, unknown>,
  prompt: LanguageModelV4Prompt,
  modelId: string,
) {
  if (!Array.isArray(args.messages)) return args;
  const assistants = prompt.filter((message) => message.role === 'assistant');
  let index = 0;
  const gemini = /^google\/gemini-/i.test(modelId);
  return {
    ...args,
    messages: args.messages.map((original) => {
      if (!isRecord(original) || original.role !== 'assistant') return original;
      const source = assistants[index++];
      if (!source) return original;
      const message = { ...original };
      const seen: JSONObject[] = [];
      let entries = [source, ...source.content]
        .flatMap((part) =>
          details(part.providerOptions?.openrouter?.reasoning_details),
        )
        .filter((entry) => {
          if (
            entry.type === 'reasoning.text' &&
            ['anthropic-claude-v1', 'google-gemini-v1'].includes(
              String(entry.format),
            ) &&
            !entry.signature
          )
            return false;
          if (seen.some((previous) => isDeepStrictEqual(previous, entry)))
            return false;
          seen.push(entry);
          return true;
        });
      if (
        gemini &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length
      ) {
        entries = entries.filter(
          (entry) =>
            entry.format === 'google-gemini-v1' ||
            (entry.type === 'reasoning.encrypted' && entry.format == null),
        );
        delete message.reasoning_content;
        delete message.reasoning;
        message.tool_calls = message.tool_calls.map((call) => {
          if (!isRecord(call)) return call;
          const part = source.content.find(
            (part) => part.type === 'tool-call' && part.toolCallId === call.id,
          );
          const extra = isRecord(call.extra_content) ? call.extra_content : {};
          const google = isRecord(extra.google) ? extra.google : {};
          const signature =
            google.thought_signature ??
            part?.providerOptions?.openrouter?.thoughtSignature ??
            part?.providerOptions?.google?.thoughtSignature;
          const signed = entries.some(
            (entry) =>
              (entry.id == null || entry.id === call.id) &&
              ((entry.type === 'reasoning.encrypted' &&
                typeof entry.data === 'string' &&
                entry.data.length > 0) ||
                (typeof entry.signature === 'string' &&
                  entry.signature.length > 0)),
          );
          if (signed && !signature) return call;
          if (!signed && !signature)
            entries.push({
              type: 'reasoning.encrypted',
              format: 'google-gemini-v1',
              id: String(call.id),
              data: SKIP_SIGNATURE,
            });
          return {
            ...call,
            extra_content: {
              ...extra,
              google: {
                ...google,
                thought_signature: signature || SKIP_SIGNATURE,
              },
            },
          };
        });
      }
      if (entries.length) {
        message.reasoning_details = entries;
        delete message.reasoning_content;
      } else if (message.reasoning_content != null) {
        message.reasoning = message.reasoning_content;
        delete message.reasoning_content;
      }
      return message;
    }),
  };
}

/** Each invocation owns its prompt and accumulator, including concurrent runs. */
export function createOpenRouterLanguageModel(
  instance: ProviderInstance,
  modelId: string,
  baseURL: string,
  headers: Record<string, string>,
): LanguageModelV4 {
  const createModel = (prompt: LanguageModelV4Prompt) =>
    createOpenAICompatible({
      name: 'openrouter',
      baseURL: setting(instance, 'baseUrl') ?? baseURL,
      apiKey: setting(instance, 'apiKey'),
      headers: { ...providerHeaders(instance, 'openai'), ...headers },
      includeUsage: true,
      transformRequestBody: (args) => restoreMessages(args, prompt, modelId),
    }).languageModel(modelId);
  return wrapLanguageModel({
    model: createModel([]),
    middleware: {
      specificationVersion: 'v4',
      wrapGenerate: async ({ params }) => {
        const result = await createModel(params.prompt).doGenerate(params);
        const message = responseMessage(result.response?.body, 'message');
        const entries = details(message.reasoning_details);
        if (!result.content.some((part) => part.type === 'reasoning')) {
          const text = reasoningText(entries);
          if (text) result.content.unshift({ type: 'reasoning', text });
        }
        return {
          ...result,
          providerMetadata: metadata(result.providerMetadata, entries),
          content: result.content.map((part) =>
            ['tool-call', 'reasoning', 'text'].includes(part.type)
              ? {
                  ...part,
                  providerMetadata: metadata(part.providerMetadata, entries),
                }
              : part,
          ),
        };
      },
      wrapStream: async ({ params }) => {
        const result = await createModel(params.prompt).doStream({
          ...params,
          includeRawChunks: true,
        });
        const entries: JSONObject[] = [];
        const pending: Extract<
          LanguageModelV4StreamPart,
          {
            type: 'tool-call' | 'tool-input-end' | 'reasoning-end' | 'text-end';
          }
        >[] = [];
        let fallbackReasoning = false;
        const emitPending = (
          controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
        ) => {
          if (fallbackReasoning) {
            controller.enqueue({
              type: 'reasoning-end',
              id: 'openrouter-reasoning-details',
              providerMetadata: metadata(undefined, entries),
            });
            fallbackReasoning = false;
          }
          for (const part of pending.splice(0))
            controller.enqueue({
              ...part,
              providerMetadata: metadata(
                'providerMetadata' in part ? part.providerMetadata : undefined,
                entries,
              ),
            });
        };
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<
              LanguageModelV4StreamPart,
              LanguageModelV4StreamPart
            >({
              transform(part, controller) {
                if (part.type === 'raw') {
                  const delta = responseMessage(part.rawValue, 'delta');
                  const incoming = details(delta.reasoning_details);
                  accumulate(entries, incoming);
                  if (!delta.reasoning && !delta.reasoning_content) {
                    const text = reasoningText(incoming);
                    if (text) {
                      if (!fallbackReasoning)
                        controller.enqueue({
                          type: 'reasoning-start',
                          id: 'openrouter-reasoning-details',
                        });
                      fallbackReasoning = true;
                      controller.enqueue({
                        type: 'reasoning-delta',
                        id: 'openrouter-reasoning-details',
                        delta: text,
                      });
                    }
                  }
                  if (params.includeRawChunks) controller.enqueue(part);
                } else if (
                  part.type === 'tool-call' ||
                  part.type === 'tool-input-end' ||
                  part.type === 'reasoning-end' ||
                  part.type === 'text-end'
                ) {
                  // A signature can follow complete tool arguments. Persist only the
                  // final snapshot, before finish makes the calls available to tools.
                  pending.push(part);
                } else if (part.type === 'finish') {
                  emitPending(controller);
                  controller.enqueue({
                    ...part,
                    providerMetadata: metadata(part.providerMetadata, entries),
                  });
                } else controller.enqueue(part);
              },
              flush: emitPending,
            }),
          ),
        };
      },
    },
  });
}

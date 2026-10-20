import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  JSONObject,
  LanguageModelV4,
} from '@ai-sdk/provider';
import {
  experimental_evaluate as evaluate,
  generateText,
  type LanguageModelUsage,
  NoObjectGeneratedError,
  Output,
} from 'ai';
import z from 'zod';

import type { InstinctModelCandidate } from '@/provider-registry';
import type { InstinctClassificationOutcome } from '@/session/chat/extensions/extension-api';
import { tracer } from '@/session/chat/utils/tracing';

import {
  distributeInstinctGeneration,
  INSTINCT_CLASSIFIER_LIMITS,
  type InstinctClassificationBatch,
  normalizeInstinctEvaluation,
  parseLenientJson,
} from './classifier';

export interface InstinctClassificationArgs
  extends InstinctClassificationBatch {
  readonly signal: AbortSignal;
  readonly deadline?: AbortSignal;
  /** Monotonic deadline shared by compilation, resolution and every attempt. */
  readonly deadlineAt: number;
}

export type InstinctClassifier = (
  args: InstinctClassificationArgs,
) => Promise<Map<string, InstinctClassificationOutcome>>;

export type InstinctAttemptUsage = Pick<
  LanguageModelUsage,
  'inputTokens' | 'outputTokens'
> &
  Partial<Pick<LanguageModelUsage, 'inputTokenDetails'>>;
interface ExecutorOptions {
  readonly candidates: readonly InstinctModelCandidate[];
  readonly sessionId?: string;
  readonly functionId: string;
  readonly onUsage?: (usage: InstinctAttemptUsage) => void;
}

/** Observes late rejection and removes the listener when either side settles. */
async function raceAbort<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Close the SDK evaluation error lifecycle even if a transport ignores abort. */
function abortableEvaluationModel(
  model: EvaluationModel,
  signal: AbortSignal,
): EvaluationModel {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedQuestionTypes: model.supportedQuestionTypes,
    doEvaluate: (options) =>
      raceAbort(
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return model.doEvaluate(options);
        }),
        signal,
      ),
  };
}

/** Close the SDK generation error lifecycle even if a transport ignores abort. */
function abortableGenerationModel(
  model: LanguageModelV4,
  signal: AbortSignal,
): LanguageModelV4 {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) =>
      raceAbort(
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return model.doGenerate(options);
        }),
        signal,
      ),
    doStream: (options) => model.doStream(options),
  };
}

/** Instinct-only, sequential execution; no config reads or durable record writes here. */
export async function executeInstinctClassification(
  args: InstinctClassificationArgs,
  options: ExecutorOptions,
): Promise<Map<string, InstinctClassificationOutcome>> {
  if (args.entries.length === 0) return new Map();
  const uniform = (outcome: InstinctClassificationOutcome) =>
    new Map(
      args.entries.map(({ extensionIdentifier }) => [
        extensionIdentifier,
        outcome,
      ]),
    );
  const { deadlineAt } = args;
  const timeout = new AbortController();
  const abortSignal = AbortSignal.any([
    args.signal,
    timeout.signal,
    ...(args.deadline ? [args.deadline] : []),
  ]);
  const interrupted = (): InstinctClassificationOutcome | undefined => {
    if (args.signal.aborted) return { status: 'aborted' };
    if (abortSignal.aborted || performance.now() >= deadlineAt)
      return { status: 'timeout' };
  };
  const timer = setTimeout(
    () => timeout.abort(new Error('instinct deadline exceeded')),
    Math.max(0, deadlineAt - performance.now()),
  );
  let salvage: Map<string, InstinctClassificationOutcome> | undefined;
  let attempted = false;
  let generationSchema: object | undefined;
  try {
    for (const candidate of options.candidates) {
      const interruption = interrupted();
      if (interruption) return uniform(interruption);
      if (candidate.status === 'unavailable') continue;
      const { entry } = candidate;
      const budget = Math.min(
        entry.attemptTimeoutMs ?? Infinity,
        deadlineAt - performance.now(),
      );
      if (budget <= 0) return uniform({ status: 'timeout' });
      const controller = new AbortController();
      const attemptTimer = setTimeout(
        () => controller.abort(new Error('instinct attempt timeout')),
        budget,
      );
      const signal = AbortSignal.any([abortSignal, controller.signal]);
      let usage: InstinctAttemptUsage | undefined;
      try {
        if (candidate.api === 'generation')
          generationSchema ??= z.toJSONSchema(args.schema);
        const payload =
          candidate.api === 'generation'
            ? {
                system: args.system,
                prompt: args.prompt,
                schema: generationSchema,
                providerOptions: entry.providerOptions,
              }
            : {
                state: args.state,
                questions: args.questions,
                providerOptions: entry.providerOptions,
              };
        if (
          JSON.stringify(payload).length >
          INSTINCT_CLASSIFIER_LIMITS.maxSerializedCharacters
        )
          throw new Error('instinct payload exceeds serialized limit');
        if (
          candidate.api === 'evaluation' &&
          Object.values(args.questions).some(
            (question) =>
              !candidate.model.supportedQuestionTypes.includes(question.type),
          )
        )
          continue;
        attempted = true;
        const result = await tracer.startActiveSpan(
          'instinct.attempt',
          {
            attributes: {
              'klex.model.api': candidate.api,
              'klex.model.provider_type': candidate.providerType,
              'klex.model.provider_id': entry.providerId,
              'klex.model.model_id': entry.modelId,
              'gen_ai.request.model': entry.modelId,
              'klex.instinct.attempt_timeout_ms': budget,
            },
          },
          async (span) => {
            try {
              const runtimeContext = {
                ...(options.sessionId && {
                  'conversation.id': options.sessionId,
                }),
                'conversation.providerType': candidate.providerType,
                'conversation.providerId': entry.providerId,
                'conversation.modelId': entry.modelId,
              };
              // Keep SDK lifecycle hooks and identity available for local usage
              // accounting at every level, just like ordinary extension calls.
              // KlexOpenTelemetry gates content to debug; the shared policy
              // sampler and span processor control whether anything is exported.
              const telemetry = {
                isEnabled: true,
                functionId: options.functionId,
                recordInputs: true,
                recordOutputs: true,
                includeRuntimeContext: {
                  'conversation.id': true,
                  'conversation.providerType': true,
                  'conversation.providerId': true,
                  'conversation.modelId': true,
                },
              };
              const sdkOptions = {
                maxRetries: 0,
                abortSignal: signal,
                providerOptions: entry.providerOptions as
                  | Record<string, JSONObject>
                  | undefined,
                telemetry,
                runtimeContext,
              };
              const work = Promise.resolve().then(
                async (): Promise<
                  Map<string, InstinctClassificationOutcome>
                > => {
                  signal.throwIfAborted();
                  if (candidate.api === 'evaluation') {
                    const result = await evaluate({
                      ...sdkOptions,
                      model: abortableEvaluationModel(candidate.model, signal),
                      state: args.state,
                      questions: args.questions,
                    });
                    usage = result.usage;
                    return normalizeInstinctEvaluation(
                      args,
                      result.answers,
                      entry.modelId,
                    );
                  }
                  const result = await generateText({
                    ...sdkOptions,
                    model: abortableGenerationModel(candidate.model, signal),
                    system: args.system,
                    prompt: args.prompt,
                    temperature: 0,
                    output: Output.object({ schema: args.schema }),
                  });
                  usage = result.usage;
                  if (result.finishReason === 'content-filter')
                    throw new Error('content-filter');
                  return distributeInstinctGeneration(
                    args.entries,
                    result.output,
                    entry.modelId,
                  );
                },
              );
              const result = await raceAbort(work, signal);
              signal.throwIfAborted();
              span.setAttribute('klex.outcome', 'success');
              return result;
            } catch (error) {
              span.setAttribute(
                'klex.outcome',
                signal.aborted ? 'aborted' : 'error',
              );
              throw error;
            } finally {
              span.end();
            }
          },
        );
        const interruption = interrupted();
        return interruption ? uniform(interruption) : result;
      } catch (error) {
        const interruption = interrupted();
        if (interruption) return uniform(interruption);
        if (
          !controller.signal.aborted &&
          candidate.api === 'generation' &&
          NoObjectGeneratedError.isInstance(error)
        ) {
          usage = error.usage;
          if (
            error.finishReason !== 'content-filter' &&
            error.text !== undefined
          )
            salvage = distributeInstinctGeneration(
              args.entries,
              parseLenientJson(error.text),
              entry.modelId,
            );
        }
      } finally {
        clearTimeout(attemptTimer);
        // Abandoned results must never update live accounting.
        if (usage && !signal.aborted && performance.now() < deadlineAt)
          options.onUsage?.(usage);
      }
    }
    const interruption = interrupted();
    return interruption
      ? uniform(interruption)
      : (salvage ??
          uniform({
            status: attempted ? 'failed' : 'unavailable',
            reason: attempted
              ? 'all instinct candidates failed'
              : 'no usable instinct candidate',
          }));
  } finally {
    clearTimeout(timer);
  }
}

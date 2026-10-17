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
import { tracer } from '@/session/chat/utils/tracing';

import {
  INSTINCT_CLASSIFIER_LIMITS,
  type InstinctClassificationCallArgs,
  type InstinctClassificationCallResult,
  normalizeInstinctEvaluation,
} from './classifier';

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
  args: InstinctClassificationCallArgs,
  options: ExecutorOptions,
): Promise<InstinctClassificationCallResult> {
  let salvage:
    | Extract<InstinctClassificationCallResult, { status: 'partial' }>
    | undefined;
  let attempted = false;
  for (const candidate of options.candidates) {
    args.abortSignal.throwIfAborted();
    if (performance.now() >= args.deadlineAt)
      throw new Error('instinct deadline exceeded');
    if (candidate.status === 'unavailable') continue;
    const { entry } = candidate;
    const budget = Math.min(
      entry.attemptTimeoutMs ?? Infinity,
      args.deadlineAt - performance.now(),
    );
    if (budget <= 0) throw new Error('instinct deadline exceeded');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('instinct attempt timeout')),
      budget,
    );
    const signal = AbortSignal.any([args.abortSignal, controller.signal]);
    let usage: InstinctAttemptUsage | undefined;
    try {
      const payload =
        candidate.api === 'generation'
          ? {
              system: args.system,
              prompt: args.prompt,
              schema: z.toJSONSchema(args.schema),
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
            'klex.instinct.api': candidate.api,
            'klex.provider.id': entry.providerId,
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
              async (): Promise<InstinctClassificationCallResult> => {
                signal.throwIfAborted();
                if (candidate.api === 'evaluation') {
                  const result = await evaluate({
                    ...sdkOptions,
                    model: abortableEvaluationModel(candidate.model, signal),
                    state: args.state,
                    questions: args.questions,
                  });
                  usage = result.usage;
                  normalizeInstinctEvaluation(
                    args,
                    result.answers,
                    entry.modelId,
                  );
                  return {
                    status: 'evaluation',
                    answers: result.answers,
                    modelId: entry.modelId,
                  };
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
                  return { status: 'failed', reason: 'content-filter' };
                return {
                  status: 'ok',
                  output: result.output,
                  modelId: entry.modelId,
                };
              },
            );
            const result = await raceAbort(work, signal);
            signal.throwIfAborted();
            span.setAttribute('klex.instinct.outcome', result.status);
            return result;
          } catch (error) {
            span.setAttribute(
              'klex.instinct.outcome',
              signal.aborted ? 'aborted' : 'failed',
            );
            throw error;
          } finally {
            span.end();
          }
        },
      );
      args.abortSignal.throwIfAborted();
      if (performance.now() >= args.deadlineAt)
        throw new Error('instinct deadline exceeded');
      if (result.status === 'ok' || result.status === 'evaluation')
        return result;
    } catch (error) {
      args.abortSignal.throwIfAborted();
      if (performance.now() >= args.deadlineAt)
        throw new Error('instinct deadline exceeded');
      if (
        !controller.signal.aborted &&
        candidate.api === 'generation' &&
        NoObjectGeneratedError.isInstance(error)
      ) {
        usage = error.usage;
        if (error.finishReason !== 'content-filter' && error.text !== undefined)
          salvage = {
            status: 'partial',
            text: error.text,
            modelId: entry.modelId,
          };
      }
    } finally {
      clearTimeout(timer);
      // Abandoned results must never update live accounting.
      if (usage && !signal.aborted && performance.now() < args.deadlineAt)
        options.onUsage?.(usage);
    }
  }
  args.abortSignal.throwIfAborted();
  if (performance.now() >= args.deadlineAt)
    throw new Error('instinct deadline exceeded');
  return (
    salvage ?? {
      status: attempted ? 'failed' : 'unavailable',
      reason: attempted
        ? 'all instinct candidates failed'
        : 'no usable instinct candidate',
    }
  );
}

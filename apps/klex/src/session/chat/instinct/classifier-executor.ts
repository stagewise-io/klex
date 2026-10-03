import type {
  Experimental_EvaluationModelV4 as EvaluationModel,
  JSONObject,
  SharedV4Warning,
} from '@ai-sdk/provider';
import {
  experimental_evaluate as evaluate,
  generateText,
  type LanguageModelUsage,
  NoObjectGeneratedError,
  Output,
} from 'ai';
import z from 'zod';

import type { InstinctModelSelectionEntry } from '@/config';
import type { InstinctModelCandidate } from '@/provider-registry';
import { tracer } from '@/session/chat/utils/tracing';

import {
  compileInstinctClassificationBatch,
  createInstinctClassifierEntries,
  distributeInstinctAnswers,
  INSTINCT_CLASSIFIER_LIMITS,
  type InstinctClassificationCallArgs,
  type InstinctClassificationCallResult,
  normalizeInstinctEvaluation,
} from './classifier';
import { buildInstinctClassifierInput } from './classifier-input';

export type InstinctAttemptUsage = Pick<
  LanguageModelUsage,
  'inputTokens' | 'outputTokens'
> &
  Partial<Pick<LanguageModelUsage, 'inputTokenDetails'>>;
export interface InstinctAttemptReport {
  readonly entry: InstinctModelSelectionEntry;
  readonly elapsedMs: number;
  readonly status: 'ok' | 'failed' | 'timeout';
  readonly usage?: InstinctAttemptUsage;
  readonly warnings: readonly string[];
}
interface ExecutorOptions {
  readonly candidates: readonly InstinctModelCandidate[];
  readonly sessionId?: string;
  readonly functionId: string;
  readonly onAttempt?: (report: InstinctAttemptReport) => void;
}

export interface InstinctOperationTestResult {
  readonly providerId: string;
  readonly modelId: string;
  readonly api: InstinctModelSelectionEntry['api'];
  readonly contractValid: boolean;
  readonly expectedAnswersMatch: boolean;
  readonly elapsedMs: number;
  readonly usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    inputCacheReadTokens: number | null;
    inputCacheWriteTokens: number | null;
  } | null;
  readonly warnings: readonly string[];
  readonly diagnostic?: string;
}

/** One explicitly requested paid operation. No conversation, fallback, or persistent verification state. */
export async function testInstinctOperation(options: {
  candidate: InstinctModelCandidate;
  abortSignal: AbortSignal;
  deadlineAt: number;
}): Promise<InstinctOperationTestResult> {
  const started = performance.now();
  const { candidate, abortSignal, deadlineAt } = options;
  let report: InstinctAttemptReport | undefined;
  let contractValid = false;
  let expectedAnswersMatch = false;
  let diagnostic: string | undefined;
  try {
    abortSignal.throwIfAborted();
    const identifier = 'core:operation-test';
    const entries = createInstinctClassifierEntries([
      {
        extensionIdentifier: identifier,
        request: {
          prompt: 'Classify only the explicit facts in the new message.',
          keys: {
            markerPresent: {
              type: 'boolean',
              description:
                'The message explicitly states that the marker is present.',
            },
            markerAbsent: {
              type: 'boolean',
              description:
                'The message explicitly states that the marker is absent.',
            },
            shape: {
              type: 'enum',
              description: 'The shape explicitly named in the message.',
              values: ['circle', 'square', 'triangle'],
            },
          },
        },
      },
    ]);
    const history = [
      {
        id: 'synthetic-operation-test',
        role: 'user' as const,
        parts: [
          {
            type: 'text' as const,
            text: 'The marker is present. The shape is square.',
          },
        ],
      },
    ];
    const prompt = buildInstinctClassifierInput({
      entries,
      history,
      delta: { initial: true, added: history, removedIds: [] },
      dataPartTransformers: {},
      limits: {
        recentMessageCount: 0,
        deltaMessageCap: 1,
        historyCharacterCap: 4000,
        messageCharacterCap: 4000,
        contextCharacterCap: 4000,
      },
    });
    const batch = compileInstinctClassificationBatch(entries, prompt);
    const result = await executeInstinctClassification(
      { ...batch, abortSignal, deadlineAt },
      {
        candidates: [candidate],
        functionId: 'operation-test',
        onAttempt: (attempt) => {
          report = attempt;
        },
      },
    );
    const outcome =
      result.status === 'evaluation'
        ? normalizeInstinctEvaluation(
            batch,
            result.answers,
            result.modelId,
          ).get(identifier)
        : result.status === 'ok'
          ? distributeInstinctAnswers(
              entries,
              result.output,
              result.modelId,
            ).get(identifier)
          : undefined;
    contractValid = outcome?.status === 'ok';
    if (outcome?.status === 'ok')
      expectedAnswersMatch =
        outcome.answers.markerPresent === true &&
        outcome.answers.markerAbsent === false &&
        outcome.answers.shape === 'square';
    else
      diagnostic =
        candidate.status === 'unavailable'
          ? 'The selected operation is unavailable.'
          : 'The operation did not return a complete classification.';
  } catch {
    diagnostic =
      abortSignal.aborted || performance.now() >= deadlineAt
        ? 'The operation was cancelled or timed out.'
        : 'The operation failed.';
  }
  const usage = report?.usage;
  return {
    providerId: candidate.entry.providerId,
    modelId: candidate.entry.modelId,
    api: candidate.entry.api,
    contractValid,
    expectedAnswersMatch,
    elapsedMs: performance.now() - started,
    usage: usage
      ? {
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          inputCacheReadTokens:
            usage.inputTokenDetails?.cacheReadTokens ?? null,
          inputCacheWriteTokens:
            usage.inputTokenDetails?.cacheWriteTokens ?? null,
        }
      : null,
    warnings: [...(report?.warnings ?? [])],
    ...(diagnostic && { diagnostic }),
  };
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

function warningSummaries(warnings: readonly SharedV4Warning[]): string[] {
  return warnings.map((warning) => {
    const feature =
      'feature' in warning &&
      typeof warning.feature === 'string' &&
      /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(warning.feature)
        ? `: ${warning.feature}`
        : '';
    return `${warning.type}${feature}`;
  });
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
    const started = performance.now();
    let usage: InstinctAttemptUsage | undefined;
    let warnings: readonly string[] = [];
    let status: InstinctAttemptReport['status'] = 'failed';
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
              state: args.prompt,
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
                    state: args.prompt,
                    questions: args.questions,
                  });
                  usage = result.usage;
                  warnings = warningSummaries(result.warnings ?? []);
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
                  model: candidate.model,
                  system: args.system,
                  prompt: args.prompt,
                  temperature: 0,
                  output: Output.object({ schema: args.schema }),
                });
                usage = result.usage;
                warnings = warningSummaries(result.warnings ?? []);
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
      if (result.status === 'ok' || result.status === 'evaluation') {
        status = 'ok';
        return result;
      }
    } catch (error) {
      args.abortSignal.throwIfAborted();
      if (performance.now() >= args.deadlineAt)
        throw new Error('instinct deadline exceeded');
      if (controller.signal.aborted) status = 'timeout';
      else if (
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
      // Abandoned results must never update live accounting or probe results.
      if (!args.abortSignal.aborted && performance.now() < args.deadlineAt)
        options.onAttempt?.({
          entry,
          elapsedMs: performance.now() - started,
          status,
          ...(controller.signal.aborted ? {} : { usage }),
          warnings: controller.signal.aborted ? [] : warnings,
        });
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

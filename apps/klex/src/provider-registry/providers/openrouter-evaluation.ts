import {
  APICallError,
  type Experimental_EvaluationModelV4Answer as EvaluationAnswer,
  type Experimental_EvaluationModelV4 as EvaluationModel,
} from '@ai-sdk/provider';
import { z } from 'zod';

import type { ProviderInstance } from '../provider-registry';
import { gatewayAttributionHeaders, providerHeaders, setting } from './shared';

const probabilities = z.record(z.string(), z.number().min(0).max(1));
const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  provider: z.string().optional(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
      z.object({
        type: z.literal('choice'),
        choice: z.string(),
        probabilities,
        confidence: z.number().nullish(),
      }),
      z.object({
        type: z.literal('score'),
        score: z.number(),
        probabilities,
        confidence: z.number().nullish(),
      }),
    ]),
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }),
});

const supportedOptions = new Set([
  'provider',
  'assets',
  'session_id',
  'trace',
  'user',
]);

/** Decisions are native evaluations, never synthetic chat completions. */
class OpenRouterEvaluationModel implements EvaluationModel {
  readonly specificationVersion = 'v4';
  readonly provider = 'openrouter';
  readonly supportedQuestionTypes = ['boolean', 'choice', 'score'] as const;

  constructor(
    readonly modelId: string,
    private readonly instance: ProviderInstance,
  ) {}

  async doEvaluate({
    state,
    questions,
    abortSignal,
    headers,
    providerOptions,
  }: Parameters<EvaluationModel['doEvaluate']>[0]): Promise<
    Awaited<ReturnType<EvaluationModel['doEvaluate']>>
  > {
    // Preserve a configured proxy prefix while replacing the versioned API path.
    const baseUrl = (
      setting(this.instance, 'baseUrl') ?? 'https://openrouter.ai/api/v1'
    ).replace(/\/$/, '');
    const url = `${baseUrl.replace(/\/v1$/, '')}/alpha/decisions`;
    const options = providerOptions?.openrouter ?? {};
    const body = {
      ...Object.fromEntries(
        Object.entries(options).filter(([key]) => supportedOptions.has(key)),
      ),
      model: this.modelId,
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          question.type === 'boolean'
            ? { ...question, type: 'noul' }
            : question,
        ]),
      ),
    };
    const requestHeaders = new Headers({
      ...providerHeaders(this.instance, 'openai'),
      ...gatewayAttributionHeaders(),
      'Content-Type': 'application/json',
    });
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (value !== undefined) requestHeaders.set(key, value);
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!response.ok)
      throw new APICallError({
        message: `OpenRouter Decisions returned HTTP ${response.status}`,
        url,
        requestBodyValues: body,
        statusCode: response.status,
        responseHeaders: Object.fromEntries(response.headers),
      });
    const raw = await response.json();
    const parsed = responseSchema.parse(raw);
    return {
      answers: Object.fromEntries(
        Object.entries(parsed.answers).map(
          ([id, answer]): [string, EvaluationAnswer] => [
            id,
            answer.type === 'noul'
              ? { type: 'boolean', probability: answer.noul }
              : answer,
          ],
        ),
      ),
      // Decisions displays probabilities and weighted scores to two decimals.
      rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
      usage: {
        inputTokens: parsed.usage.input_tokens,
        outputTokens: parsed.usage.output_tokens,
      },
      warnings: Object.keys(options)
        .filter((key) => !supportedOptions.has(key))
        .map((key) => ({
          type: 'unsupported' as const,
          feature: `providerOptions.openrouter.${key}`,
        })),
      providerMetadata: {
        openrouter: {
          ...(parsed.provider && { provider: parsed.provider }),
          ...(parsed.usage.cost !== undefined && { cost: parsed.usage.cost }),
          confidence: Object.fromEntries(
            Object.entries(parsed.answers).flatMap(([id, answer]) =>
              answer.type !== 'noul' && answer.confidence != null
                ? [[id, answer.confidence]]
                : [],
            ),
          ),
        },
      },
      response: {
        id: parsed.id,
        modelId: parsed.model,
        headers: Object.fromEntries(response.headers),
        body: raw,
      },
    };
  }
}

export function createOpenRouterEvaluationModel(
  instance: ProviderInstance,
  modelId: string,
): EvaluationModel {
  return new OpenRouterEvaluationModel(modelId, instance);
}

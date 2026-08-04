import { SpanKind } from '@opentelemetry/api';
import { generateObject } from 'ai';
import z from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';
import type { ContextMetadataValue } from '@/session/inbox';
import {
  mapProviderName,
  recordErrorOnSpan,
  tracer,
  withSpan,
} from '@/tracing';

import SYSTEM_PROMPT from './routing-system-prompt.md';

const routingDecisionSchema = z.object({
  sessionId: z
    .string()
    .describe(
      'Short ID of the existing session to route to. Empty string to create a new session.',
    ),
  priority: z.enum(['low', 'medium', 'high']),
  summary: z
    .string()
    .describe(
      'Brief summary of what the target session is doing now. Empty string if unchanged.',
    ),
});

type RoutingDecision = z.infer<typeof routingDecisionSchema>;

interface SessionRoutingInfo {
  shortId: string;
  summary: string | null;
  status: string;
  runtimeState: string;
}

interface RoutingDecisionParams {
  logger: ModuleLogger;
  modelProvider: ModelProvider;
  routingModels: readonly ModelId[];
  sessions: SessionRoutingInfo[];
  eventMetadata: Record<string, ContextMetadataValue>;
  sourceEnv: string;
  contentPreview: string;
  /**
   * When provided, the LLM should use this priority instead of
   * deciding its own. The router still calls the LLM for session
   * selection and summary, but ignores the LLM's priority field.
   */
  presetPriority?: string;
}

export type { RoutingDecision, RoutingDecisionParams, SessionRoutingInfo };

/**
 * Builds gen_ai semantic-convention attributes for a routing LLM call span.
 * Parses the klex modelId (format: providerId:endpointId:modelId or
 * providerId:modelId) to extract individual components.
 */
function buildGenAiAttributes(modelId: ModelId): Record<string, string> {
  const parts = modelId.split(':');
  const providerId = parts.length >= 2 ? parts[0] : undefined;
  const endpointId = parts.length >= 3 ? parts[1] : undefined;
  const modelIdOnly =
    parts.length >= 3 ? parts[2] : parts.length === 2 ? parts[1] : undefined;

  const providerName = providerId ? mapProviderName(providerId) : 'unknown';

  const attrs: Record<string, string> = {
    'gen_ai.operation.name': 'generate_content',
    'gen_ai.system': providerName,
    'gen_ai.provider.name': providerName,
    'gen_ai.request.model': modelId,
    'gen_ai.request.stream': 'false',
    'gen_ai.agent.name': 'router',
  };

  if (providerId != null) attrs['klex.model.provider_id'] = providerId;
  if (endpointId != null) attrs['klex.model.endpoint_id'] = endpointId;
  if (modelIdOnly != null) attrs['klex.model.model_id'] = modelIdOnly;

  return attrs;
}

export async function callRoutingLlm(
  params: RoutingDecisionParams,
): Promise<RoutingDecision | null> {
  const {
    logger,
    modelProvider,
    routingModels,
    sessions,
    eventMetadata,
    sourceEnv,
    contentPreview,
    presetPriority,
  } = params;

  if (routingModels.length === 0) {
    return null;
  }

  const prompt = JSON.stringify({
    sessions,
    event: {
      sourceEnv,
      metadata: eventMetadata,
      contentPreview,
      ...(presetPriority ? { presetPriority } : {}),
    },
  });

  for (const modelId of routingModels) {
    const spanName = `generate_content ${modelId}`;
    const span = tracer.startSpan(spanName, {
      attributes: buildGenAiAttributes(modelId),
      kind: SpanKind.INTERNAL,
    });

    try {
      const model = await modelProvider.get(modelId);
      const result = await withSpan(span, () =>
        generateObject({
          model,
          schema: routingDecisionSchema,
          system: SYSTEM_PROMPT,
          prompt,
        }),
      );

      // Record usage and finish reason on the span.
      span.setAttributes({
        'gen_ai.response.model': modelId,
        'gen_ai.response.finish_reasons': [result.finishReason],
        'gen_ai.usage.input_tokens': result.usage.inputTokens,
        'gen_ai.usage.output_tokens': result.usage.outputTokens,
      });

      return result.object;
    } catch (error) {
      recordErrorOnSpan(span, error);
      logger.warn({ error, modelId }, 'Routing LLM model failed — trying next');
    } finally {
      span.end();
    }
  }

  logger.warn('All routing models failed — falling back to default routing');
  return null;
}

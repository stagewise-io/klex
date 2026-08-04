import { generateObject } from 'ai';
import z from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';
import type { ContextMetadataValue } from '@/session/inbox';

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
    try {
      const model = await modelProvider.get(modelId);
      const result = await generateObject({
        model,
        schema: routingDecisionSchema,
        system: SYSTEM_PROMPT,
        prompt,
        telemetry: {
          isEnabled: true,
          functionId: 'router',
        },
      });

      return result.object;
    } catch (error) {
      logger.warn({ error, modelId }, 'Routing LLM model failed — trying next');
    }
  }

  logger.warn('All routing models failed — falling back to default routing');
  return null;
}

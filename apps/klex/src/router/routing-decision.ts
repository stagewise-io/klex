import { generateObject } from 'ai';
import z from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';

import SYSTEM_PROMPT from './routing-system-prompt.md';

const routingDecisionSchema = z.object({
  sessionChoice: z.enum(['new', 'existing']),
  sessionId: z
    .string()
    .optional()
    .describe(
      'Short ID of the existing session to route to. Required when sessionChoice is "existing".',
    ),
  priority: z.enum(['low', 'medium', 'high']),
  summary: z
    .string()
    .optional()
    .describe(
      'Brief summary of what the target session is doing now. Omit if unchanged.',
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
  eventMetadata: Record<string, string | number | boolean>;
  sourceEnv: string;
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
  } = params;

  if (routingModels.length === 0) {
    return null;
  }

  const prompt = JSON.stringify({
    sessions,
    event: { sourceEnv, metadata: eventMetadata },
  });

  for (const modelId of routingModels) {
    try {
      const model = await modelProvider.get(modelId);
      const result = await generateObject({
        model,
        schema: routingDecisionSchema,
        system: SYSTEM_PROMPT,
        prompt,
      });
      return result.object;
    } catch (error) {
      logger.warn({ error, modelId }, 'Routing LLM model failed — trying next');
    }
  }

  logger.warn('All routing models failed — falling back to default routing');
  return null;
}

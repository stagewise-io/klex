import { describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { createOpenAIRealtimeProcessorFactory } from './openai-realtime';

const enabled = process.env.OPENAI_REALTIME_INTEGRATION === '1';
const apiKey = process.env.OPENAI_API_KEY;
const integrationTest = enabled && apiKey ? it : it.skip;

const logging = {
  child: () => ({ warn: () => undefined }),
} as unknown as RootLogger;

describe('OpenAI realtime real provider', () => {
  integrationTest(
    'configures a session and closes cleanly',
    async () => {
      const controller = new AbortController();
      const factory = createOpenAIRealtimeProcessorFactory({
        logging,
        config: {
          modelId: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1',
          apiKey: apiKey as string,
          websocketUrl: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1')}`,
          voice: process.env.OPENAI_REALTIME_VOICE ?? 'marin',
          instructions: 'Respond only when speech is provided.',
          serverVad: {},
        },
      });
      const processor = await factory.create({
        namespace: 'integration',
        sessionId: 'provider',
        signal: controller.signal,
      });
      await processor.close();
      await expect(processor.closed).resolves.toMatchObject({ type: 'closed' });
    },
    20_000,
  );
});

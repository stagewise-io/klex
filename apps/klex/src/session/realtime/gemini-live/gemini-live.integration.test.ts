import { describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { GeminiLiveModelId } from '@/config';
import { SessionInboxUrgency } from '@/session/inbox';

import { createGeminiLiveProcessorFactory } from './gemini-live';

const enabled = process.env.GEMINI_LIVE_INTEGRATION === '1';
const apiKey = process.env.GEMINI_API_KEY;
const integrationTest = enabled && apiKey ? it : it.skip;
const websocketUrl =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const models: GeminiLiveModelId[] = [
  'gemini-3.8-live',
  'gemini-3.8-live-extended-thinking',
];

const logging = {
  child: () => ({ debug: () => undefined, warn: () => undefined }),
} as unknown as RootLogger;

async function nextWithTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
): Promise<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Gemini Live response timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }),
    ]);
    if (result.done) throw new Error('Gemini Live response stream closed');
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
    await iterator.return?.();
  }
}

describe('Gemini Live real provider', () => {
  for (const modelId of models) {
    integrationTest(
      `${modelId} completes setup, responds with audio and transcription, and closes cleanly`,
      async () => {
        const controller = new AbortController();
        const factory = createGeminiLiveProcessorFactory({
          logging,
          config: {
            modelId,
            apiKey: apiKey as string,
            websocketUrl,
            ...(modelId === 'gemini-3.8-live-extended-thinking' && {
              thinkingLevel: 'low',
            }),
          },
        });
        const session = await factory.create({
          namespace: 'integration',
          sessionId: modelId,
          signal: controller.signal,
        });

        try {
          const audio = nextWithTimeout(session.audioOutput, 45_000);
          const transcript = nextWithTimeout(session.events, 45_000);
          await session.sendUpdate({
            sequence: 1,
            eventId: `integration:${modelId}:prompt`,
            requestResponse: true,
            event: {
              eventId: `integration:${modelId}:prompt`,
              sourceEnv: 'integration',
              urgency: SessionInboxUrgency.Default,
              context: {
                sourceEnv: 'integration',
                metadata: {},
                content: [{ type: 'text', text: 'Say the single word hello.' }],
              },
            },
          });

          await expect(audio).resolves.toMatchObject({
            encoding: 'pcm-s16le',
            sampleRateHz: 48_000,
            channels: 1,
          });
          await expect(transcript).resolves.toMatchObject({
            type: 'assistant-transcript',
          });
        } finally {
          await session.close();
        }
        await expect(session.closed).resolves.toMatchObject({ type: 'closed' });
      },
      60_000,
    );
  }
});

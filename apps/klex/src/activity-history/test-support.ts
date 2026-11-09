import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@stagewise/logger';

import { klexConfigSchema } from '@/config';
import { createLocalData, type LocalDataStoreDefinition } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  createSessionHistory,
  SESSION_HISTORY_STORE_DEFINITION,
} from '@/session-history';

import { createActivityHistory } from './activity-history';

export const TEST_ACTIVITY_LIMITS = {
  maxCharacters: 40_000,
  maxDurationMs: 30 * 60_000,
  idleTimeoutMs: 5 * 60_000,
};

/** Real SQLite fixture shared by memory consumer tests; no episode publisher. */
export async function createActivityFixture(
  stores: LocalDataStoreDefinition[] = [],
) {
  const directory = await mkdtemp(join(tmpdir(), 'klex-canonical-activity-'));
  const logging = createLogger({ name: 'activity-test' });
  let now = new Date('2026-10-01T12:00:00Z');
  await createLocalData({
    logging,
    dataDirectory: directory,
    klexVersion: KLEX_VERSION,
    stores: [SESSION_HISTORY_STORE_DEFINITION, ...stores],
  }).start();
  const history = createSessionHistory({
    logging,
    dataDirectory: directory,
    config: { get: () => klexConfigSchema.parse({}) },
    now: () => now,
  });
  await history.start();
  const recorder = history.openRecorder({
    instanceId: randomUUID(),
    sessionId: 'default',
    kind: 'default',
    name: 'Default',
    createdAt: now.toISOString(),
  });
  let messages: ExtendedUIMessage[] = [];
  return {
    directory,
    logging,
    history,
    activities: createActivityHistory(history),
    now: () => now.getTime(),
    setTime: (value: string) => {
      now = new Date(value);
    },
    async sync(next: ExtendedUIMessage[]) {
      messages = next;
      recorder.scheduleSync(() => messages);
      await history.flush();
    },
    async append(text: string, role: 'user' | 'assistant' = 'assistant') {
      messages = [
        ...messages,
        { id: randomUUID(), role, parts: [{ type: 'text', text }] },
      ];
      recorder.scheduleSync(() => messages);
      await history.flush();
      return (await history.activityManifest()).at(-1)!;
    },
    async close() {
      await history.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

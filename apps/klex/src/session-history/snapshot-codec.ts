import { createHash } from 'node:crypto';

import type { Client, InStatement } from '@libsql/client';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

const snapshotParts = new Set([
  'data-loadedMemories',
  'data-loadedMemorySections',
]);
const digest = (content: string) =>
  createHash('sha256').update(content).digest('hex');

/** Storage-only encoding. Never mutate a canonical message or its logical revision. */
export function encodeSnapshots(
  content: string,
  statements: InStatement[],
  interned = new Set<string>(),
): string {
  const message = JSON.parse(content);
  for (const part of message.parts ?? []) {
    if (
      !snapshotParts.has(part.type) ||
      !part.data ||
      typeof part.data !== 'object' ||
      Array.isArray(part.data)
    )
      continue;
    for (const [key, value] of Object.entries(part.data)) {
      if (typeof value !== 'string') continue;
      const hash = digest(value);
      if (!interned.has(hash)) {
        statements.push({
          sql: 'INSERT INTO memory_snapshots(hash, content) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING',
          args: [hash, value],
        });
        interned.add(hash);
      }
      part.data[key] = { snapshotRef: hash };
    }
  }
  return JSON.stringify(message);
}

/** Hydrate within the history queue, before any consumer observes the message. */
export async function decodeSnapshots(
  client: Client,
  content: string,
): Promise<ExtendedUIMessage> {
  const message = JSON.parse(content);
  const references = new Map<
    string,
    { data: Record<string, unknown>; key: string }[]
  >();
  for (const part of message.parts ?? []) {
    if (
      !snapshotParts.has(part.type) ||
      !part.data ||
      typeof part.data !== 'object' ||
      Array.isArray(part.data)
    )
      continue;
    for (const [key, value] of Object.entries(part.data)) {
      if (typeof value === 'string') continue; // Legacy inline rows.
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !('snapshotRef' in value) ||
        typeof value.snapshotRef !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.snapshotRef)
      ) {
        throw new Error('Corrupt session memory snapshot reference');
      }
      const targets = references.get(value.snapshotRef) ?? [];
      targets.push({ data: part.data, key });
      references.set(value.snapshotRef, targets);
    }
  }
  const hashes = [...references.keys()];
  for (let index = 0; index < hashes.length; index += 100) {
    const batch = hashes.slice(index, index + 100);
    const result = await client.execute({
      sql: `SELECT hash, content FROM memory_snapshots WHERE hash IN (${batch.map(() => '?').join(',')})`,
      args: batch,
    });
    if (result.rows.length !== batch.length)
      throw new Error('Missing session memory snapshot');
    for (const row of result.rows) {
      const hash = String(row.hash);
      const value = String(row.content);
      if (digest(value) !== hash)
        throw new Error('Corrupt session memory snapshot content');
      for (const target of references.get(hash)!)
        target.data[target.key] = value;
    }
  }
  return message as ExtendedUIMessage;
}

export const pruneSnapshots: InStatement = {
  sql: 'DELETE FROM memory_snapshots WHERE NOT EXISTS (SELECT 1 FROM message_memory_snapshots WHERE message_memory_snapshots.hash = memory_snapshots.hash)',
  args: [],
};

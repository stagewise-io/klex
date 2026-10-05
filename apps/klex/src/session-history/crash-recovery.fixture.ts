import { createLogger } from '@stagewise/logger';

import {
  AdmissionGate,
  AdmissionRejectedError,
  type MaintenanceLease,
} from '@/admission';
import { klexConfigSchema } from '@/config';
import { createDirectoryLock } from '@/directory-lock';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { SESSION_HISTORY_STORE_DEFINITION } from './schema';
import { createSessionHistory } from './session-history';

// Executed in real child processes by crash-recovery.test.ts, using production
// directory ownership, registry preflight/recovery, history, and admission.
const [mode, directoryArgument, serializedLease] = process.argv.slice(2);
if (!directoryArgument) throw new Error('Missing directory');
const dataDirectory: string = directoryArgument;
const logging = createLogger({ name: 'crash-fixture', type: 'hidden' });
const lock = createDirectoryLock({ logging, dataDirectory });
const gate = new AdmissionGate();
const history = createSessionHistory({
  logging,
  dataDirectory,
  admission: gate,
  config: { get: () => klexConfigSchema.parse({}) },
  now: () => new Date('2026-01-02T03:04:05.000Z'),
});

async function run() {
  await lock.acquire();
  await createLocalData({
    logging,
    dataDirectory,
    klexVersion: KLEX_VERSION,
    stores: [SESSION_HISTORY_STORE_DEFINITION],
  }).start();
  await history.start();
  if (mode === 'owner') {
    const messages: ExtendedUIMessage[] = [
      {
        id: 'committed',
        role: 'user',
        parts: [{ type: 'text', text: 'committed transcript' }],
      },
    ];
    const recorder = history.openRecorder({
      instanceId: 'crash-session',
      sessionId: 'default',
      kind: 'default',
      name: 'Default',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    recorder.scheduleSync(() => messages);
    await history.flush();
    const first = await gate.prepare();
    if (first.outcome !== 'quiescent')
      throw new Error('Expected initial certificate');
    gate.abort('Continue running', first.lease);
    const committed = await history.getMessages(recorder.instanceId, {
      limit: 100,
    });
    const session = await history.getSession(recorder.instanceId);
    const entered = Promise.withResolvers<void>();
    const barrier = Promise.withResolvers<void>();
    void (
      history as typeof history & {
        enqueue(task: () => Promise<void>): Promise<void>;
      }
    ).enqueue(async () => {
      entered.resolve();
      await barrier.promise;
    });
    await entered.promise;
    messages.push({
      id: 'queued-only',
      role: 'user',
      parts: [{ type: 'text', text: 'not committed' }],
    });
    recorder.scheduleSync(() => messages);
    let certified = false;
    void gate.prepare().then((result) => {
      certified = result.outcome === 'quiescent';
    });
    // IPC barrier: parent kills us only after this message. No transcript SQL
    // for queued-only has run; this proves queued loss, not SQL rollback.
    process.send?.({
      type: 'ready',
      committed,
      session,
      lease: first.lease,
      status: gate.status(),
      certified,
    });
    process.on('message', () => {
      process.send?.({ type: 'status', status: gate.status(), certified });
    });
    return;
  }
  const recovered = await history.getMessages('crash-session', { limit: 100 });
  const session = await history.getSession('crash-session');
  const result = await gate.prepare();
  if (result.outcome !== 'quiescent')
    throw new Error('Recovery failed to certify');
  const stale = JSON.parse(serializedLease ?? '{}') as MaintenanceLease;
  let rejected = false;
  try {
    gate.consume(stale);
  } catch (error) {
    rejected = error instanceof AdmissionRejectedError;
  }
  process.send?.({
    type: 'recovered',
    recovered,
    session,
    rejected,
    epoch: result.lease.epoch,
    status: gate.status(),
  });
  gate.abort('Recovery test complete', result.lease);
  await history.close();
  gate.close();
  await lock.release();
  process.disconnect?.();
}

void run().catch(async (error: unknown) => {
  gate.close();
  await history.close();
  await lock.release();
  process.send?.({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  process.disconnect?.();
});

import { randomUUID } from 'node:crypto';

import { decodeJwt } from 'jose';

import type { WorkloadInfo, WorkloadTracker } from '../workloads/index.js';

/** Cloud leases live 90 s; renewing every 30 s tolerates two lost reports. */
export const LEASE_RENEW_INTERVAL_MS = 30_000;
/** Cloud accepts at most this many workloads per report. */
export const MAX_REPORT_WORKLOADS = 128;

export interface MachineLeaseReporterOptions {
  /** `{cloud}/api/machines/{id}/lifecycle/report`. */
  reportUrl: string;
  /** Token with `machine:lifecycle-report` scope and a generation claim. */
  getToken(): Promise<string>;
  invalidateToken(): void;
  fetch?: typeof globalThis.fetch;
  renewIntervalMs?: number;
  /** Retry delay after a failed report; shorter than the renew interval. */
  retryDelayMs?: number;
  /** Report failures and lost protection; never silently assume protection. */
  onError?(error: unknown): void;
}

export interface MachineLeaseReporter {
  /** Report one principal's workloads under its OAuth client ID. */
  track(clientId: string, workloads: WorkloadTracker): () => void;
  /** Resolves after the next report attempt; for shutdown and tests. */
  flush(): Promise<void>;
  /** Stops reporting. Unreleased Cloud leases expire on their own TTL. */
  close(): void;
}

/** Thrown through `onError` when Cloud stops protecting a running workload. */
export class WorkloadLeaseError extends Error {
  constructor(
    readonly workloadId: string,
    readonly code: string,
  ) {
    super(`Cloud rejected workload lease ${workloadId}: ${code}`);
  }
}

type LeaseState = 'acquire' | 'held' | 'release';

interface Lease {
  clientId: string;
  /** Cloud lease identity; rotated when Cloud reports it expired. */
  leaseId: string;
  state: LeaseState;
  /** Sent to Cloud at least once under `leaseId`; may exist there. */
  sent: boolean;
  generation?: number;
}

type ReportResult =
  | { workloadId: string; expiresAt: string | null }
  | { workloadId: string; error: string };

/**
 * Mirrors local workload trackers into individual Cloud leases.
 *
 * Every tracked workload owns one lease: it is acquired when work starts,
 * renewed while work runs (silent or not), and released exactly once when the
 * local handle is released. Only workloads are reported; heartbeats and
 * catalog publication never create leases.
 */
export function createMachineLeaseReporter(
  options: MachineLeaseReporterOptions,
): MachineLeaseReporter {
  const fetch = options.fetch ?? globalThis.fetch;
  const renewIntervalMs = options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const controller = new AbortController();
  const leases = new Map<string, Lease>();
  const subscriptions = new Set<() => void>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let dirty = false;

  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // Error reporting must not break lease accounting.
    }
  };

  const schedule = (delayMs: number) => {
    if (controller.signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (leases.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
    timer.unref();
  };

  const sync = (clientId: string, workloads: readonly WorkloadInfo[]) => {
    const live = new Set(workloads.map((workload) => workload.id));
    for (const workload of workloads) {
      if (!leases.has(workload.id))
        leases.set(workload.id, {
          clientId,
          leaseId: randomUUID(),
          state: 'acquire',
          sent: false,
        });
    }
    for (const [id, lease] of leases) {
      if (lease.clientId !== clientId || live.has(id)) continue;
      // Never sent to Cloud: nothing to release.
      if (!lease.sent) leases.delete(id);
      else lease.state = 'release';
    }
    dirty = true;
    schedule(0);
  };

  const send = async (): Promise<void> => {
    if (leases.size === 0) return;
    const token = await options.getToken();
    const generation = decodeJwt(token).machine_generation;
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      throw new Error('Lease report token has no machine generation');
    }
    // Leases are generation-scoped: after a replacement, held leases belong to
    // a dead generation, so live work must acquire fresh ones.
    for (const [id, lease] of leases) {
      if (lease.generation === undefined || lease.generation === generation)
        continue;
      if (lease.state === 'release') leases.delete(id);
      else rotate(lease);
    }
    const entries = [...leases.entries()];
    for (let start = 0; start < entries.length; start += MAX_REPORT_WORKLOADS)
      await sendChunk(
        token,
        generation,
        entries.slice(start, start + MAX_REPORT_WORKLOADS),
      );
  };

  const sendChunk = async (
    token: string,
    generation: number,
    chunk: [string, Lease][],
  ): Promise<void> => {
    const sent = chunk.map(([id, lease]) => {
      lease.sent = true;
      return {
        id,
        lease,
        leaseId: lease.leaseId,
        action: lease.state === 'held' ? 'renew' : lease.state,
      };
    });
    const response = await fetch(options.reportUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        generation,
        workloads: sent.map((entry) => ({
          clientId: entry.lease.clientId,
          workloadId: entry.leaseId,
          action: entry.action,
        })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Auth or generation changed: a fresh token carries current claims.
      if (response.status === 401 || response.status === 409)
        options.invalidateToken();
      throw new Error(`Lease report returned ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    const results = new Map(
      readResults(body).map((result) => [result.workloadId, result]),
    );
    for (const entry of sent) {
      // A newer local transition (or rotation) wins over this response.
      if (
        leases.get(entry.id) !== entry.lease ||
        entry.lease.leaseId !== entry.leaseId
      )
        continue;
      const result = results.get(entry.leaseId);
      if (!result) continue;
      if (entry.action === 'release') {
        // Released, already gone or rejected: Cloud no longer protects it.
        if (entry.lease.state === 'release') leases.delete(entry.id);
        continue;
      }
      if ('error' in result) {
        if (entry.lease.state === 'release') {
          leases.delete(entry.id);
          continue;
        }
        report(new WorkloadLeaseError(entry.id, result.error));
        // Cloud never renews an expired lease; protect the work anew.
        rotate(entry.lease);
        continue;
      }
      if (entry.lease.state === 'acquire') entry.lease.state = 'held';
      entry.lease.generation = generation;
    }
  };

  const run = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    if (running) {
      dirty = true;
      return running;
    }
    dirty = false;
    running = (async () => {
      let failed = false;
      try {
        await send();
      } catch (error) {
        if (!controller.signal.aborted) report(error);
        failed = true;
      } finally {
        running = undefined;
      }
      // Local changes during the report go out at once. Unconfirmed
      // transitions retry soon, but never in a tight loop.
      if (dirty && !failed) schedule(0);
      else if (
        failed ||
        [...leases.values()].some((lease) => lease.state !== 'held')
      )
        schedule(retryDelayMs);
      else schedule(renewIntervalMs);
    })();
    return running;
  };

  return {
    track(clientId, workloads) {
      if (controller.signal.aborted) return () => undefined;
      const unsubscribe = workloads.onChange((snapshot) =>
        sync(clientId, snapshot),
      );
      subscriptions.add(unsubscribe);
      sync(clientId, workloads.list());
      return () => {
        if (!subscriptions.delete(unsubscribe)) return;
        unsubscribe();
        sync(clientId, []);
      };
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await run();
    },
    close() {
      controller.abort();
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
      leases.clear();
    },
  };
}

/** Replace a lease Cloud no longer honours with a fresh identity. */
function rotate(lease: Lease): void {
  lease.state = 'acquire';
  lease.leaseId = randomUUID();
  lease.sent = false;
  delete lease.generation;
}

function readResults(body: unknown): ReportResult[] {
  if (typeof body !== 'object' || body === null) return [];
  const workloads = (body as { workloads?: unknown }).workloads;
  if (!Array.isArray(workloads)) return [];
  return workloads.flatMap((item): ReportResult[] => {
    if (typeof item !== 'object' || item === null) return [];
    const { workloadId, error, expiresAt } = item as Record<string, unknown>;
    if (typeof workloadId !== 'string') return [];
    if (typeof error === 'string') return [{ workloadId, error }];
    return [
      {
        workloadId,
        expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
      },
    ];
  });
}

import { randomUUID } from 'node:crypto';

/** Upper bound for explicitly protected work whose completion is unknowable. */
export const MAX_EXPLICIT_PROTECTION_MS = 4 * 60 * 60 * 1000;

export type WorkloadKind = 'command' | 'shell-protection';

export interface WorkloadInfo {
  /** Stable per workload; lease reporting uses it as the lease identity. */
  id: string;
  kind: WorkloadKind;
  /** Command or shell session the workload protects. */
  subjectId: string;
  startedAt: string;
  /** Present only for bounded protection; finite commands end on exit. */
  expiresAt?: string;
}

export interface WorkloadHandle {
  readonly id: string;
  readonly expiresAt?: string;
  /** Idempotent. Releasing one workload never affects another. */
  release(): void;
}

type Listener = (workloads: readonly WorkloadInfo[]) => void;

/**
 * Process-local registry of machine work that must keep the machine awake.
 *
 * It records explicit facts only — a running finite command or a caller's
 * bounded protection request — never PTY liveness, output silence or CPU use.
 */
export class WorkloadTracker {
  readonly #workloads = new Map<string, WorkloadInfo>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #listeners = new Set<Listener>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  acquire(options: {
    kind: WorkloadKind;
    subjectId: string;
    durationMs?: number;
  }): WorkloadHandle {
    const startedAt = this.#now();
    const id = randomUUID();
    const info: WorkloadInfo = {
      id,
      kind: options.kind,
      subjectId: options.subjectId,
      startedAt: new Date(startedAt).toISOString(),
    };
    if (options.durationMs !== undefined) {
      const durationMs = boundedDuration(options.durationMs);
      info.expiresAt = new Date(startedAt + durationMs).toISOString();
      const timer = setTimeout(() => this.#release(id), durationMs);
      timer.unref();
      this.#timers.set(id, timer);
    }
    this.#workloads.set(id, info);
    this.#emit();
    return {
      id,
      ...(info.expiresAt ? { expiresAt: info.expiresAt } : {}),
      release: () => this.#release(id),
    };
  }

  /** Releases every workload protecting `subjectId`, e.g. a closed session. */
  releaseSubject(subjectId: string): void {
    let changed = false;
    for (const workload of [...this.#workloads.values()]) {
      if (workload.subjectId !== subjectId) continue;
      changed = this.#delete(workload.id) || changed;
    }
    if (changed) this.#emit();
  }

  list(): WorkloadInfo[] {
    return [...this.#workloads.values()].map((workload) => ({ ...workload }));
  }

  get active(): boolean {
    return this.#workloads.size > 0;
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    const changed = this.#workloads.size > 0;
    this.#workloads.clear();
    if (changed) this.#emit();
    this.#listeners.clear();
  }

  #release(id: string): void {
    if (this.#delete(id)) this.#emit();
  }

  #delete(id: string): boolean {
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
    return this.#workloads.delete(id);
  }

  #emit(): void {
    const snapshot = this.list();
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}

function boundedDuration(durationMs: number): number {
  if (
    !Number.isInteger(durationMs) ||
    durationMs < 1_000 ||
    durationMs > MAX_EXPLICIT_PROTECTION_MS
  ) {
    throw new Error(
      `durationMs must be an integer from 1000 to ${MAX_EXPLICIT_PROTECTION_MS}`,
    );
  }
  return durationMs;
}

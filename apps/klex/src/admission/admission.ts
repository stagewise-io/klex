import { AsyncLocalStorage } from 'node:async_hooks';

export class AdmissionRejectedError extends Error {
  readonly retryable = true;

  constructor() {
    super('Runtime is preparing maintenance; retry later');
    this.name = 'AdmissionRejectedError';
  }
}

export interface WorkLease {
  run<Result>(operation: () => Result): Result;
  release(): void;
}

export interface MaintenanceLease {
  readonly epoch: number;
}

export interface AdmissionStatus {
  state: 'open' | 'draining' | 'quiescent' | 'closed';
  epoch: number;
  deadline: number | null;
  activeWork: number;
  deferredWork: number;
  blockers: string[];
  reason: string | null;
}

export type MaintenanceResult =
  | { outcome: 'quiescent'; lease: MaintenanceLease }
  | { outcome: 'aborted'; reason: string };

interface WorkRecord {
  depth: number;
  descendants: { remaining: number };
}

export class AdmissionGate {
  private readonly context = new AsyncLocalStorage<WorkRecord>();
  private readonly work = new Set<WorkRecord>();
  private readonly participants = new Set<() => readonly string[]>();
  private readonly deferred = new Map<object, () => void>();
  private readonly cancellations = new Map<object, () => void>();
  private state: AdmissionStatus['state'] = 'open';
  private epoch = 0;
  private deadline: number | null = null;
  private reason: string | null = null;
  private maintenance: MaintenanceLease | undefined;
  private complete: ((result: MaintenanceResult) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: {
      graceMs?: number;
      maxDescendants?: number;
      maxDepth?: number;
    } = {},
  ) {
    this.options = Object.freeze({ ...options });
    const graceMs = options.graceMs ?? 60_000;
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new RangeError('Drain grace must be a finite nonnegative duration');
    }
    for (const bound of [options.maxDescendants ?? 64, options.maxDepth ?? 2]) {
      if (!Number.isSafeInteger(bound) || bound < 0) {
        throw new RangeError('Descendant bounds must be nonnegative integers');
      }
    }
  }

  admit(): WorkLease {
    const parent = this.context.getStore();
    const descendant = parent !== undefined && this.work.has(parent);
    if (
      this.state !== 'open' &&
      (this.state !== 'draining' ||
        !descendant ||
        parent.depth >= (this.options.maxDepth ?? 2) ||
        parent.descendants.remaining === 0)
    ) {
      throw new AdmissionRejectedError();
    }
    if (this.state === 'draining' && descendant) {
      parent.descendants.remaining -= 1;
    }
    const record: WorkRecord = {
      depth: descendant ? parent.depth + 1 : 0,
      descendants: descendant
        ? parent.descendants
        : { remaining: this.options.maxDescendants ?? 64 },
    };
    this.work.add(record);
    return {
      run: (operation) => {
        if (!this.work.has(record)) throw new AdmissionRejectedError();
        return this.context.run(record, operation);
      },
      release: () => {
        this.work.delete(record);
        this.check();
      },
    };
  }

  admitRoot(): WorkLease {
    return this.context.exit(() => this.admit());
  }

  ownsCurrentWork(): boolean {
    const work = this.context.getStore();
    return work !== undefined && this.work.has(work);
  }

  async run<Result>(
    operation: () => Result | Promise<Result>,
  ): Promise<Result> {
    const lease = this.admit();
    try {
      return await lease.run(operation);
    } finally {
      lease.release();
    }
  }

  async checkpoint(): Promise<void> {
    if (this.state === 'open') return;
    const parent = this.context.getStore();
    if (
      this.state === 'draining' &&
      parent &&
      this.work.has(parent) &&
      parent.descendants.remaining > 0
    ) {
      parent.descendants.remaining -= 1;
      return;
    }
    if (this.state === 'closed') throw new AdmissionRejectedError();
    await new Promise<void>((resolve) => this.background({}, resolve, resolve));
    if (this.status().state === 'closed') throw new AdmissionRejectedError();
  }

  background(key: object, operation: () => void, onClosed?: () => void): void {
    if (this.state === 'closed') {
      onClosed?.();
      return;
    }
    if (this.state !== 'open') {
      this.deferred.set(key, operation);
      if (onClosed) this.cancellations.set(key, onClosed);
      if (this.state === 'quiescent') this.abort('Deferred work arrived');
      else if (this.deferred.size >= 1_024)
        this.abort('Deferred work limit reached');
      return;
    }
    this.context.exit(operation);
  }

  register(participant: () => readonly string[]): () => void {
    if (this.state === 'closed') throw new AdmissionRejectedError();
    this.participants.add(participant);
    if (this.state === 'quiescent') this.abort('Participant changed');
    return () => {
      this.participants.delete(participant);
      this.check();
    };
  }

  status(): AdmissionStatus {
    const blockers: string[] = [];
    for (const participant of this.participants) {
      try {
        blockers.push(...participant());
      } catch {
        blockers.push('Participant safety is uncertain');
      }
    }
    return {
      state: this.state,
      epoch: this.epoch,
      deadline: this.deadline,
      activeWork: this.work.size,
      deferredWork: this.deferred.size,
      blockers,
      reason: this.reason,
    };
  }

  prepare(options: { graceMs?: number } = {}): Promise<MaintenanceResult> {
    if (this.state !== 'open') throw new AdmissionRejectedError();
    const graceMs = options.graceMs ?? this.options.graceMs ?? 60_000;
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new RangeError('Drain grace must be a finite nonnegative duration');
    }
    this.state = 'draining';
    for (const record of this.work)
      record.descendants.remaining = this.options.maxDescendants ?? 64;
    this.epoch += 1;
    this.deadline = Date.now() + graceMs;
    this.reason = null;
    this.maintenance = Object.freeze({ epoch: this.epoch });
    const result = new Promise<MaintenanceResult>((resolve) => {
      this.complete = resolve;
    });
    const lease = this.maintenance;
    this.timer = setTimeout(
      () => this.abort('Drain grace expired', lease),
      graceMs,
    );
    this.poll = setInterval(() => {
      if (this.maintenance === lease) this.check();
    }, 10);
    if (this.status().blockers.length > 0) {
      this.abort('Participant safety is uncertain');
    } else {
      this.check();
    }
    return result;
  }

  abort(reason: string, lease?: MaintenanceLease): boolean {
    if (
      (this.state !== 'draining' && this.state !== 'quiescent') ||
      (lease !== undefined && lease !== this.maintenance)
    ) {
      return false;
    }
    this.clearTimers();
    this.state = 'open';
    this.reason = reason;
    this.deadline = null;
    this.maintenance = undefined;
    const complete = this.complete;
    this.complete = undefined;
    complete?.({ outcome: 'aborted', reason });
    for (const [key, operation] of [...this.deferred]) {
      this.deferred.delete(key);
      try {
        this.context.exit(operation);
        this.cancellations.delete(key);
      } catch {
        this.deferred.set(key, operation);
        this.reason = 'Deferred work could not resume';
      }
    }
    return true;
  }

  consume(lease: MaintenanceLease): void {
    if (
      this.state !== 'quiescent' ||
      lease !== this.maintenance ||
      Date.now() >= (this.deadline ?? 0) ||
      this.work.size > 0 ||
      this.deferred.size > 0 ||
      this.status().blockers.length > 0
    ) {
      if (lease === this.maintenance)
        this.abort('Quiescence proof is no longer valid', lease);
      throw new AdmissionRejectedError();
    }
    this.close();
  }

  close(): void {
    this.clearTimers();
    this.state = 'closed';
    this.deadline = null;
    this.reason = 'Runtime closed';
    this.maintenance = undefined;
    this.complete?.({ outcome: 'aborted', reason: 'Runtime closed' });
    this.complete = undefined;
    const cancellations = [...this.cancellations.values()];
    this.cancellations.clear();
    this.deferred.clear();
    for (const cancel of cancellations) {
      try {
        cancel();
      } catch {
        // One failed notification must not prevent other owners from settling
        // their queues or prevent ordinary runtime teardown from continuing.
        this.reason = 'Deferred work cancellation failed';
      }
    }
  }

  private check(): void {
    if (this.state !== 'draining') return;
    if (this.status().blockers.length > 0) {
      this.abort('Participant safety is uncertain');
      return;
    }
    if (this.work.size > 0 || this.deferred.size > 0) return;
    if (Date.now() >= (this.deadline ?? 0)) {
      this.abort('Drain grace expired');
      return;
    }
    this.state = 'quiescent';
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    const complete = this.complete;
    this.complete = undefined;
    if (this.maintenance) {
      complete?.({ outcome: 'quiescent', lease: this.maintenance });
    }
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.timer = undefined;
    this.poll = undefined;
  }
}

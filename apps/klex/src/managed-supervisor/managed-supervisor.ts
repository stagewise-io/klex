import {
  MANAGED_LEASE_TIMING,
  type ManagedLeaseRequest,
  managedLeaseResponseSchema,
} from './protocol';

export interface ManagedLeaseDeadline {
  accept(input: {
    request: ManagedLeaseRequest;
    response: unknown;
    sentAt: number;
  }): void;
  observe(): {
    phase: 'waiting' | 'run' | 'drain' | 'expired';
    hardStopAt: number | null;
    sequence: number;
  };
}

/** Separate from the bot event loop; this controller never consults Date.now(). */
class ManagedLeaseDeadlineModule implements ManagedLeaseDeadline {
  private hardStopAt: number | null = null;
  private fundedUntil: string | null = null;
  private sequence = 0;
  private expiryDrain = false;
  private ordinaryDrain = false;

  constructor(private readonly monotonicNow: () => number) {}

  observe(): ReturnType<ManagedLeaseDeadline['observe']> {
    const now = this.monotonicNow();
    if (this.hardStopAt === null)
      return { phase: 'waiting', hardStopAt: null, sequence: this.sequence };
    if (now >= this.hardStopAt - MANAGED_LEASE_TIMING.drainLeadMs)
      this.expiryDrain = true;
    return {
      phase:
        now >= this.hardStopAt
          ? 'expired'
          : this.expiryDrain || this.ordinaryDrain
            ? 'drain'
            : 'run',
      hardStopAt: this.hardStopAt,
      sequence: this.sequence,
    };
  }

  accept(input: {
    request: ManagedLeaseRequest;
    response: unknown;
    sentAt: number;
  }) {
    const response = managedLeaseResponseSchema.parse(input.response);
    const now = this.monotonicNow();
    const elapsed = now - input.sentAt;
    if (
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed > MANAGED_LEASE_TIMING.requestTimeoutMs
    )
      throw new Error('Lease response exceeded the request budget');
    for (const key of [
      'agentId',
      'activationId',
      'sessionId',
      'attemptId',
      'podUid',
      'nonce',
    ] as const) {
      if (response[key] !== input.request[key])
        throw new Error(`Lease response ${key} mismatch`);
    }
    const before = this.observe();
    if (before.phase === 'expired' || this.expiryDrain)
      throw new Error('Expiry drain cannot be reversed');
    if (response.sequence < this.sequence)
      throw new Error('Lease sequence moved backwards');
    if (
      response.sequence === this.sequence &&
      response.fundedUntil !== this.fundedUntil
    )
      throw new Error('Lease deadline changed without advancing its sequence');
    if (this.ordinaryDrain && response.mode === 'run')
      throw new Error('Ordinary drain cannot resume execution');
    const remaining =
      Date.parse(response.fundedUntil) -
      Date.parse(response.serverNow) -
      elapsed -
      MANAGED_LEASE_TIMING.safetyMarginMs;
    if (!Number.isFinite(remaining)) throw new Error('Invalid lease duration');
    // Subtracting the entire RTT intentionally errs toward early termination.
    const deadline = now + Math.max(0, remaining);
    this.hardStopAt =
      response.mode === 'deny'
        ? now
        : response.sequence === this.sequence && this.hardStopAt !== null
          ? Math.min(this.hardStopAt, deadline)
          : deadline;
    this.sequence = response.sequence;
    this.fundedUntil = response.fundedUntil;
    if (response.mode === 'drain') this.ordinaryDrain = true;
    this.observe();
  }
}

export function createManagedLeaseDeadline(
  monotonicNow: () => number,
): ManagedLeaseDeadline {
  return new ManagedLeaseDeadlineModule(monotonicNow);
}

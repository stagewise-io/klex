import {
  type DesktopInputControl,
  DesktopInputDeniedError,
} from './input-control.js';

/** How long a human lease survives a lost Cloud control connection. */
export const LEASE_DISCONNECT_GRACE_MS = 30_000;

export type DesktopControlMode = 'agent' | 'human';

export interface DesktopLeaseUpdate {
  mode: DesktopControlMode;
  holder?: { name?: string; streamId?: string } | null;
  expiresAt?: string | null;
}

export type DesktopControlChangeReason = 'cloud' | 'expired' | 'disconnected';

export interface DesktopControlState {
  mode: DesktopControlMode;
  /** Display name of the person in control; `undefined` in agent mode. */
  holder?: string;
  /** Only this viewer stream may send input; any stream when omitted. */
  streamId?: string;
  expiresAt?: string;
}

export interface DesktopControlChange extends DesktopControlState {
  reason: DesktopControlChangeReason;
  sequence: number;
  changedAt: string;
}

export type DesktopControlListener = (change: DesktopControlChange) => void;

const UNNAMED_HOLDER = 'A person';
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Who may send input to the desktop. Cloud decides; this enforces its last
 * decision locally and reverts to the agent when a human lease expires or the
 * Cloud connection stays down, so a lost connection cannot lock the agent out.
 */
export class DesktopControlLease implements DesktopInputControl {
  readonly #listeners = new Set<DesktopControlListener>();
  readonly #now: () => number;
  #state: DesktopControlState = { mode: 'agent' };
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #grace: ReturnType<typeof setTimeout> | undefined;
  #sequence = 0;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  get state(): DesktopControlState {
    return { ...this.#state };
  }

  authorize(): void {
    this.#expireIfDue();
    if (this.#state.mode !== 'human') return;
    const holder = this.#state.holder ?? UNNAMED_HOLDER;
    throw new DesktopInputDeniedError(
      `${holder} is controlling this desktop. Wait for a desktop.control_changed notification with mode "agent" before sending input. Screenshots still work.`,
      { holder },
    );
  }

  /** Whether RFB input from this viewer stream reaches the desktop. */
  allowsStreamInput(streamId: string): boolean {
    this.#expireIfDue();
    if (this.#state.mode !== 'human') return false;
    return !this.#state.streamId || this.#state.streamId === streamId;
  }

  apply(update: DesktopLeaseUpdate): void {
    this.#clearGrace();
    const expiresAt =
      update.mode === 'human' && update.expiresAt
        ? Date.parse(update.expiresAt)
        : Number.NaN;
    // A malformed expiry fails closed to the agent instead of an unbounded lease.
    const expired =
      update.mode === 'human' &&
      !!update.expiresAt &&
      !(expiresAt > this.#now());
    if (expired) {
      this.#set({ mode: 'agent' }, 'expired');
      return;
    }
    this.#set(
      update.mode === 'human'
        ? {
            mode: 'human',
            holder: update.holder?.name?.trim() || UNNAMED_HOLDER,
            ...(update.holder?.streamId
              ? { streamId: update.holder.streamId }
              : {}),
            ...(Number.isFinite(expiresAt)
              ? { expiresAt: new Date(expiresAt).toISOString() }
              : {}),
          }
        : { mode: 'agent' },
      'cloud',
    );
  }

  /** Cloud's control connection dropped; Cloud resends the lease on reconnect. */
  disconnected(): void {
    if (this.#state.mode !== 'human' || this.#grace) return;
    this.#grace = setTimeout(() => {
      this.#grace = undefined;
      this.#set({ mode: 'agent' }, 'disconnected');
    }, LEASE_DISCONNECT_GRACE_MS);
    this.#grace.unref?.();
  }

  onChange(listener: DesktopControlListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#clearGrace();
    clearTimeout(this.#expiry);
    this.#expiry = undefined;
    this.#listeners.clear();
  }

  #set(next: DesktopControlState, reason: DesktopControlChangeReason): void {
    clearTimeout(this.#expiry);
    this.#expiry = undefined;
    if (next.mode === 'human' && next.expiresAt)
      this.#scheduleExpiry(Date.parse(next.expiresAt));
    const previous = this.#state;
    this.#state = next;
    if (previous.mode === next.mode && previous.holder === next.holder) return;
    const change: DesktopControlChange = {
      ...next,
      reason,
      sequence: ++this.#sequence,
      changedAt: new Date(this.#now()).toISOString(),
    };
    for (const listener of this.#listeners) {
      try {
        listener({ ...change });
      } catch {
        // A failing subscriber must not block enforcement or other subscribers.
      }
    }
  }

  #scheduleExpiry(expiresAt: number): void {
    const delay = expiresAt - this.#now();
    this.#expiry = setTimeout(
      () => {
        this.#expiry = undefined;
        if (this.#now() < expiresAt) {
          this.#scheduleExpiry(expiresAt);
          return;
        }
        this.#clearGrace();
        this.#set({ mode: 'agent' }, 'expired');
      },
      Math.min(Math.max(0, delay), MAX_TIMER_MS),
    );
    this.#expiry.unref?.();
  }

  #expireIfDue(): void {
    const { mode, expiresAt } = this.#state;
    if (mode !== 'human' || !expiresAt) return;
    if (Date.parse(expiresAt) > this.#now()) return;
    this.#clearGrace();
    this.#set({ mode: 'agent' }, 'expired');
  }

  #clearGrace(): void {
    clearTimeout(this.#grace);
    this.#grace = undefined;
  }
}

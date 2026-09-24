/**
 * Process-local accumulator for per-window session activity.
 *
 * Privacy boundary: sessions are tracked through opaque handles only. No
 * session id, name, kind, or content is ever stored here, so nothing
 * identifying can leak into a snapshot.
 */

/** Opaque per-session recorder. Holds no identity. */
export interface AnalyticsSessionHandle {
  /** Records one completed turn with the number of steps it took. */
  recordTurn(steps: number): void;
  /** Marks the session closed. Idempotent. */
  close(): void;
}

export interface SessionWindowAggregate {
  sessionsStarted: number;
  sessionsEnded: number;
  /** Sessions with at least one turn in the window. */
  sessionsActive: number;
  turnsTotal: number;
  stepsTotal: number;
  turnsPerSessionMax: number;
  stepsPerSessionMax: number;
}

interface SessionCounter {
  turns: number;
  steps: number;
  closed: boolean;
}

export const NOOP_SESSION_HANDLE: AnalyticsSessionHandle = {
  recordTurn: () => undefined,
  close: () => undefined,
};

export class SessionAggregator {
  private readonly sessions = new Set<SessionCounter>();
  private sessionsStarted = 0;
  private sessionsEnded = 0;

  openSession(): AnalyticsSessionHandle {
    const counter: SessionCounter = { turns: 0, steps: 0, closed: false };
    this.sessions.add(counter);
    this.sessionsStarted++;
    return {
      recordTurn: (steps) => {
        if (counter.closed) return;
        counter.turns++;
        counter.steps +=
          Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : 0;
      },
      close: () => {
        if (counter.closed) return;
        counter.closed = true;
        this.sessionsEnded++;
      },
    };
  }

  /**
   * Returns the finished window and starts a new one in the same synchronous
   * step, so no update can fall between snapshot and reset. Open sessions
   * carry into the next window with zeroed counts; closed ones are dropped.
   */
  snapshotAndReset(): SessionWindowAggregate {
    const aggregate: SessionWindowAggregate = {
      sessionsStarted: this.sessionsStarted,
      sessionsEnded: this.sessionsEnded,
      sessionsActive: 0,
      turnsTotal: 0,
      stepsTotal: 0,
      turnsPerSessionMax: 0,
      stepsPerSessionMax: 0,
    };
    for (const counter of this.sessions) {
      if (counter.turns > 0) {
        aggregate.sessionsActive++;
        aggregate.turnsTotal += counter.turns;
        aggregate.stepsTotal += counter.steps;
        aggregate.turnsPerSessionMax = Math.max(
          aggregate.turnsPerSessionMax,
          counter.turns,
        );
        aggregate.stepsPerSessionMax = Math.max(
          aggregate.stepsPerSessionMax,
          counter.steps,
        );
      }
      if (counter.closed) this.sessions.delete(counter);
      else {
        counter.turns = 0;
        counter.steps = 0;
      }
    }
    this.sessionsStarted = 0;
    this.sessionsEnded = 0;
    return aggregate;
  }
}

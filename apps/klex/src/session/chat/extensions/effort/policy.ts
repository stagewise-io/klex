export interface EffortSignals {
  demand: number;
  failing: boolean;
  consequential: boolean;
  missingEvidence: boolean;
  /** Positive evidence that the difficult subproblem is resolved or no longer relevant. */
  resolved?: boolean;
  /** Verified progress, not merely a successful tool invocation. */
  progress?: boolean;
}
export type ActiveEffort = 'low' | 'medium' | 'high';

/** Future structured failure sources can supply this; no memory reader is wired. */
export interface EffortTrigger {
  readonly kind: 'semantic-failure';
  readonly objectiveId: string;
  readonly provenance: string;
}

export interface EffortState {
  readonly active: ActiveEffort;
  readonly lowerProgress: number;
  readonly resolutionSeen: boolean;
}

export const initialEffortState: EffortState = {
  active: 'low',
  lowerProgress: 0,
  resolutionSeen: false,
};

export interface EffortDecision {
  intent: 'low' | 'medium' | 'high';
  reason: string;
}

/** Rubric index, not calibrated confidence. Information gaps are not solved by thinking longer. */
export function chooseEffort(
  signals: EffortSignals | undefined,
): EffortDecision {
  if (signals?.failing && !signals.missingEvidence)
    return { intent: 'high', reason: 'semantic-failure-trigger' };
  if (!signals) return { intent: 'low', reason: 'classifier-unavailable' };
  if (signals.missingEvidence && !signals.consequential)
    return { intent: 'low', reason: 'gather-missing-evidence' };
  if (signals.demand >= 2.5 || (signals.failing && signals.demand >= 1.5))
    return { intent: 'high', reason: 'hard-next-step' };
  if (signals.demand >= 1.5 || signals.consequential)
    return { intent: 'medium', reason: 'bounded-reasoning-or-consequence' };
  return { intent: 'low', reason: 'routine-next-step' };
}

/** Pure proposal: callers commit only after a usable, non-aborted generation. */
export function advanceEffort(
  state: EffortState,
  signals: EffortSignals | undefined,
  options: {
    floor: ActiveEffort;
    ceiling: ActiveEffort;
    objectiveId?: string;
    triggers?: readonly EffortTrigger[];
  },
): EffortDecision & { state: EffortState } {
  const tiers = ['low', 'medium', 'high'] as const;
  const clamp = (tier: ActiveEffort) =>
    Math.max(
      tiers.indexOf(options.floor),
      Math.min(tiers.indexOf(options.ceiling), tiers.indexOf(tier)),
    );
  const triggered = options.triggers?.some(
    (trigger) =>
      trigger.objectiveId === options.objectiveId &&
      trigger.provenance.trim().length > 0,
  );
  const desired = triggered
    ? { intent: 'high' as const, reason: 'structured-failure-trigger' }
    : chooseEffort(signals);
  const current = clamp(state.active);
  const target = clamp(desired.intent);
  if (target >= current) {
    return {
      intent: tiers[target] ?? 'low',
      reason: desired.reason,
      state: {
        active: tiers[target] ?? 'low',
        lowerProgress: 0,
        resolutionSeen: false,
      },
    };
  }
  // Missing classification/evidence cannot be mistaken for resolution.
  const resolutionSeen = state.resolutionSeen || signals?.resolved === true;
  const confirming =
    !!signals &&
    !signals.failing &&
    !signals.missingEvidence &&
    signals.progress === true;
  const lowerProgress =
    confirming && resolutionSeen ? state.lowerProgress + 1 : 0;
  if (resolutionSeen && lowerProgress >= 2) {
    const active = tiers[current - 1] ?? 'low';
    return {
      intent: active,
      reason: 'evidence-gated-decay',
      state: { active, lowerProgress: 0, resolutionSeen },
    };
  }
  return {
    intent: tiers[current] ?? 'low',
    reason: 'holding-unresolved-or-unconfirmed',
    state: { active: tiers[current] ?? 'low', lowerProgress, resolutionSeen },
  };
}

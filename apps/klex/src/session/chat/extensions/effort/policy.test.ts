import { describe, expect, it } from 'vitest';

import { advanceEffort, chooseEffort, initialEffortState } from './policy';

describe('low-first policy', () => {
  it.each([
    ['greeting', 0, false, false, false, 'low'],
    ['lookup', 0, false, false, false, 'low'],
    ['tool continuation', 1, false, false, false, 'low'],
    ['large mechanical output', 1, false, false, false, 'low'],
    ['short hard question', 3, false, false, false, 'high'],
    ['multi-constraint plan', 2, false, false, false, 'medium'],
    ['contradictory results', 2, true, false, false, 'high'],
    ['ambiguous evidence', 3, false, false, true, 'low'],
    ['irreversible action', 1, false, true, false, 'medium'],
  ] as const)(
    '%s',
    (_label, demand, failing, consequential, missingEvidence, intent) => {
      expect(
        chooseEffort({ demand, failing, consequential, missingEvidence })
          .intent,
      ).toBe(intent);
    },
  );
  it('escalates immediately and decays only with resolution and repeated progress', () => {
    const bounds = { floor: 'low', ceiling: 'high' } as const;
    const routine = {
      demand: 0,
      failing: false,
      consequential: false,
      missingEvidence: false,
      progress: true,
    };
    let result = advanceEffort(
      initialEffortState,
      { ...routine, failing: true },
      bounds,
    );
    expect(result.intent).toBe('high');
    for (let i = 0; i < 5; i++) {
      result = advanceEffort(result.state, routine, bounds);
      expect(result.intent).toBe('high');
    }
    result = advanceEffort(result.state, undefined, bounds);
    expect(result.intent).toBe('high');
    result = advanceEffort(
      result.state,
      { ...routine, resolved: true },
      bounds,
    );
    expect(result.intent).toBe('high');
    result = advanceEffort(result.state, routine, bounds);
    expect(result.intent).toBe('medium');
    result = advanceEffort(result.state, routine, bounds);
    expect(result.intent).toBe('medium');
    result = advanceEffort(result.state, routine, bounds);
    expect(result.intent).toBe('low');
  });
  it('retains resolution across equal-tier steps but clears it on escalation', () => {
    const bounds = { floor: 'low', ceiling: 'high' } as const;
    const routine = {
      demand: 0,
      failing: false,
      consequential: false,
      missingEvidence: false,
      progress: true,
    };
    let result = advanceEffort(
      { active: 'high', lowerProgress: 0, resolutionSeen: false },
      { ...routine, demand: 3, resolved: true },
      bounds,
    );
    expect(result.state.resolutionSeen).toBe(true);
    result = advanceEffort(result.state, { ...routine, demand: 3 }, bounds);
    expect(result.state.resolutionSeen).toBe(true);
    result = advanceEffort(result.state, routine, bounds);
    expect(result.intent).toBe('high');
    result = advanceEffort(result.state, routine, bounds);
    expect(result.intent).toBe('medium');
    result = advanceEffort(result.state, { ...routine, demand: 3 }, bounds);
    expect(result.state.resolutionSeen).toBe(false);
  });
  it('scopes future structured triggers and respects bounds', () => {
    const options = {
      floor: 'low',
      ceiling: 'high',
      objectiveId: 'task',
      triggers: [
        {
          kind: 'semantic-failure',
          objectiveId: 'task',
          provenance: 'verified-check',
        },
      ],
    } as const;
    expect(advanceEffort(initialEffortState, undefined, options).intent).toBe(
      'high',
    );
    expect(
      advanceEffort(initialEffortState, undefined, {
        ...options,
        objectiveId: 'other',
      }).intent,
    ).toBe('low');
    expect(
      advanceEffort(initialEffortState, undefined, {
        ...options,
        ceiling: 'medium',
      }).intent,
    ).toBe('medium');
  });
  it('does not promote classifier failure at the baseline', () => {
    expect(chooseEffort(undefined).intent).toBe('low');
  });
});

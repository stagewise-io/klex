import {
  defineInstinctClassification,
  type Extension,
  type ExtensionDeps,
  type ExtensionFactory,
  type InstinctContext,
  type InstinctInput,
  readInstinctClassification,
  type StepCompleteEvent,
} from '../extension-api';
import {
  advanceEffort,
  chooseEffort,
  type EffortState,
  initialEffortState,
} from './policy';

const defaultConfig = {
  mode: 'shadow',
  floor: 'low',
  ceiling: 'high',
} as const;

const request = defineInstinctClassification({
  prompt:
    'Assess the NEXT generation step, not the entire project. Length is not difficulty. Operational/auth/network failures are not reasoning failures. Missing information usually requires gathering evidence. Judge only the fixed rubric; do not choose provider parameters.',
  keys: {
    demand: {
      type: 'score',
      description: 'Non-routine reasoning needed for the next action.',
      levels: [
        {
          label: 'mechanical',
          description: 'Known action, lookup, or routine continuation.',
        },
        {
          label: 'bounded',
          description: 'Straightforward interpretation with a known method.',
        },
        {
          label: 'synthesis',
          description: 'Several constraints or conflicting observations.',
        },
        {
          label: 'novel',
          description:
            'Unresolved novel reasoning or difficult root-cause analysis.',
        },
      ],
    },
    failing: {
      type: 'boolean',
      description:
        'Current approach has semantic failures or contradictory evidence, not infrastructure errors.',
    },
    consequential: {
      type: 'boolean',
      description:
        'An incorrect next action would be consequential or difficult to reverse.',
    },
    resolved: {
      type: 'boolean',
      description:
        'Positive evidence shows the previously difficult subproblem is resolved or no longer relevant. Absence of errors and tool execution success alone are not evidence.',
    },
    progress: {
      type: 'boolean',
      description:
        'Since the previous generation, verified results demonstrate progress toward the objective, not merely a successful tool invocation.',
    },
    missingEvidence: {
      type: 'boolean',
      description:
        'Missing evidence rather than reasoning is the main blocker.',
    },
  },
});

class EffortExt implements Extension {
  private state: EffortState = initialEffortState;
  private lastObjective: string | undefined;
  private pending:
    | { state: EffortState; objective: string | undefined }
    | undefined;
  constructor(private readonly deps: ExtensionDeps) {}

  onStepStart(): void {
    this.pending = undefined;
  }

  getInstinctClassificationRequest(input: InstinctInput) {
    const config = this.deps.config.get().effort ?? defaultConfig;
    if (config.mode === 'off') return null;
    // Do not create an expensive classification solely for effort when no cheap Instinct model is selected.
    if (this.deps.config.getModelSelection('instincts').length === 0)
      return null;
    const last = input.history.at(-1);
    if (
      last?.role === 'user' &&
      last.parts.length === 1 &&
      last.parts[0]?.type === 'text' &&
      /^(hi|hello|thanks|thank you)[.!\s]*$/i.test(last.parts[0].text)
    )
      return null;
    return request;
  }

  onInstinct(ctx: InstinctContext): void {
    const config = this.deps.config.get().effort ?? defaultConfig;
    if (config.mode === 'off') {
      this.state = initialEffortState;
      this.lastObjective = undefined;
      this.pending = undefined;
      return;
    }
    const objective = ctx.history.findLast(
      (message) => message.role === 'user',
    )?.id;
    const state =
      objective === this.lastObjective ? this.state : initialEffortState;
    const answers = readInstinctClassification(ctx, request);
    const decision = advanceEffort(state, answers ?? undefined, {
      floor: config.floor,
      ceiling: config.ceiling,
      objectiveId: objective,
    });
    this.pending = { state: decision.state, objective };
    ctx.prepare.setEffort({
      intent: decision.intent,
      mode: config.mode,
      reason: decision.reason,
      diagnostics: {
        desired: chooseEffort(answers ?? undefined).intent,
        previous: state.active,
        objectiveReset: objective !== this.lastObjective,
        lowerProgress: decision.state.lowerProgress,
        resolutionSeen: decision.state.resolutionSeen,
        classificationAvailable: answers !== null,
        ...(answers ?? {}),
      },
    });
  }

  onStepComplete(event: StepCompleteEvent): void {
    if (
      !event.instinctAborted &&
      event.generation &&
      !event.generationFailed &&
      !event.requestRejected &&
      this.pending
    ) {
      this.state = this.pending.state;
      this.lastObjective = this.pending.objective;
    }
    this.pending = undefined;
  }
}

export const createEffortExt: ExtensionFactory = {
  identifier: 'io.stagewise/effort',
  displayName: 'Dynamic effort',
  create: (deps) => new EffortExt(deps),
};

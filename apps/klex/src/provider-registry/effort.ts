import type { JSONObject, LanguageModelV4CallOptions } from '@ai-sdk/provider';

export type EffortTier = 'low' | 'medium' | 'high' | 'exceptional';
export type EffortIntent = EffortTier | 'off' | 'provider-default';
export type NativeEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
export interface EffortEvidence {
  readonly source: 'reviewed' | 'discovered' | 'operator' | 'tentative';
  readonly reference: string;
}
export type EffortControl =
  | {
      readonly kind: 'levels';
      readonly values: readonly NativeEffort[];
      readonly default?: NativeEffort;
    }
  | {
      readonly kind: 'budget';
      readonly minimum: number;
      readonly maximum: number;
      readonly outputHeadroom: number;
      readonly budgets: Readonly<Record<EffortTier, number>>;
    }
  | { readonly kind: 'switch'; readonly canDisable: boolean };
export type EffortEncoding =
  | 'portable'
  | 'compatible'
  | 'openrouter'
  | 'anthropic-budget'
  | 'google-budget'
  | 'anthropic-adaptive';
export type EffortCapability =
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | {
      readonly kind: 'fixed';
      readonly enabled: boolean;
      readonly evidence: EffortEvidence;
    }
  | {
      readonly kind: 'controlled';
      readonly controls: readonly EffortControl[];
      readonly encoding: EffortEncoding;
      readonly namespace: string;
      readonly mandatory: boolean;
      readonly evidence: EffortEvidence;
    };
export interface EffortIdentity {
  readonly providerId: string;
  readonly providerType: string;
  readonly modelId: string;
}
export interface EffortResolution {
  readonly identity: EffortIdentity;
  readonly requested: EffortIntent;
  readonly status:
    | 'exact'
    | 'approximate'
    | 'fixed'
    | 'unknown'
    | 'unsupported'
    | 'tentative'
    | 'provider-default';
  readonly effective?: NativeEffort | number | boolean;
  readonly reasoning?: LanguageModelV4CallOptions['reasoning'];
  readonly providerOptions?: Record<string, JSONObject>;
  readonly reason: string;
  readonly evidence?: EffortEvidence;
}

const levels: readonly NativeEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const target: Record<EffortTier, NativeEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  exceptional: 'max',
};
const reasoningKeys = new Set([
  'reasoningEffort',
  'reasoning_effort',
  'reasoning',
  'thinking',
  'thinkingConfig',
  'reasoningConfig',
  'enable_thinking',
  'thinking_budget',
  'output_config',
  'effort',
]);

/** Preserve every explicit reasoning control, including controls in foreign namespaces. */
export function hasFixedEffort(
  options: Record<string, JSONObject> | undefined,
): boolean {
  return Object.values(options ?? {}).some((value) =>
    Object.keys(value).some((key) => reasoningKeys.has(key)),
  );
}

/** Only exact reviewed generations; opaque deployments and new aliases stay unknown. */
export function reviewedEffortCapability(
  identity: EffortIdentity,
): EffortCapability {
  if (identity.providerType === 'typesafe-ai')
    return { kind: 'unsupported', reason: 'evaluation-only' };
  if (
    identity.providerType === 'openai' &&
    ['o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'].includes(
      identity.modelId,
    )
  ) {
    return {
      kind: 'controlled',
      controls: [{ kind: 'levels', values: ['low', 'medium', 'high'] }],
      encoding: 'portable',
      namespace: 'openai',
      mandatory: true,
      evidence: {
        source: 'reviewed',
        reference: 'https://developers.openai.com/api/docs/guides/reasoning',
      },
    };
  }
  if (
    identity.providerType === 'anthropic' &&
    ['claude-sonnet-4-6', 'claude-opus-4-6'].includes(identity.modelId)
  ) {
    return {
      kind: 'controlled',
      controls: [{ kind: 'levels', values: ['low', 'medium', 'high'] }],
      encoding: 'anthropic-adaptive',
      namespace: 'anthropic',
      mandatory: false,
      evidence: {
        source: 'reviewed',
        reference:
          'https://platform.claude.com/docs/en/build-with-claude/effort',
      },
    };
  }
  return { kind: 'unknown', reason: 'No exact reviewed effort profile' };
}

/** Strict parser for OpenRouter catalog data. A reasoning boolean is insufficient. */
export function ollamaEffortCapability(
  value: unknown,
): EffortCapability | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const data = value as Record<string, unknown>;
  if (
    !Array.isArray(data.values) ||
    data.values.length === 0 ||
    data.values.length > levels.length ||
    !data.values.every(
      (item) =>
        typeof item === 'string' && levels.includes(item as NativeEffort),
    ) ||
    new Set(data.values).size !== data.values.length ||
    !data.values.includes(data.default)
  )
    return undefined;
  return {
    kind: 'controlled',
    controls: [
      {
        kind: 'levels',
        values: [...data.values] as NativeEffort[],
        default: data.default as NativeEffort,
      },
    ],
    encoding: 'compatible',
    namespace: 'ollama',
    mandatory: !data.values.includes('none'),
    evidence: {
      source: 'discovered',
      reference: 'https://docs.ollama.com/capabilities/thinking',
    },
  };
}

export function openRouterEffortCapability(
  value: unknown,
): EffortCapability | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const data = value as Record<string, unknown>;
  if (
    !Array.isArray(data.supported_efforts) ||
    data.supported_efforts.length === 0 ||
    data.supported_efforts.length > levels.length ||
    typeof data.mandatory !== 'boolean'
  )
    return undefined;
  const supported = data.supported_efforts;
  if (
    !supported.every(
      (item): item is NativeEffort =>
        typeof item === 'string' && levels.includes(item as NativeEffort),
    ) ||
    new Set(supported).size !== supported.length ||
    (data.mandatory && supported.includes('none'))
  )
    return undefined;
  if (
    data.default_effort !== undefined &&
    !supported.includes(data.default_effort as NativeEffort)
  )
    return undefined;
  return {
    kind: 'controlled',
    controls: [
      {
        kind: 'levels',
        values: [...supported],
        ...(data.default_effort !== undefined && {
          default: data.default_effort as NativeEffort,
        }),
      },
    ],
    encoding: 'openrouter',
    namespace: 'openrouter',
    mandatory: data.mandatory,
    evidence: {
      source: 'discovered',
      reference: 'https://openrouter.ai/api/v1/models',
    },
  };
}

export function resolveEffort(input: {
  readonly identity: EffortIdentity;
  readonly intent: EffortIntent;
  readonly capability: EffortCapability;
  readonly providerOptions?: Record<string, JSONObject>;
  readonly maxOutputTokens?: number;
}): EffortResolution {
  const providerOptions =
    input.providerOptions && structuredClone(input.providerOptions);
  const base = {
    identity: { ...input.identity },
    requested: input.intent,
    providerOptions,
  };
  if (hasFixedEffort(providerOptions))
    return { ...base, status: 'fixed', reason: 'explicit-reasoning-options' };
  if (input.intent === 'provider-default')
    return {
      ...base,
      status: 'provider-default',
      reason: 'configured-default',
    };
  const capability = input.capability;
  if (capability.kind === 'unknown' || capability.kind === 'unsupported')
    return { ...base, status: capability.kind, reason: capability.reason };
  if (capability.kind === 'fixed')
    return {
      ...base,
      status: 'fixed',
      effective: capability.enabled,
      reason: 'model-fixed',
      evidence: capability.evidence,
    };
  const evidence = capability.evidence;
  if (capability.controls.length !== 1)
    return {
      ...base,
      status: 'unsupported',
      reason: 'combined-controls-require-reviewed-encoder',
      evidence,
    };
  if (input.intent === 'off' && capability.mandatory)
    return {
      ...base,
      status: 'unsupported',
      reason: 'mandatory-thinking',
      evidence,
    };
  const discrete = capability.controls.find(
    (control) => control.kind === 'levels',
  );
  const budget = capability.controls.find(
    (control) => control.kind === 'budget',
  );
  const toggle = capability.controls.find(
    (control) => control.kind === 'switch',
  );
  let effective: NativeEffort | number | boolean;
  let exact = true;
  if (discrete) {
    const desired = input.intent === 'off' ? 'none' : target[input.intent];
    const available = levels.filter(
      (level) =>
        discrete.values.includes(level) &&
        (!capability.mandatory || level !== 'none'),
    );
    const selected =
      desired === 'none'
        ? available.find((level) => level === 'none')
        : available.find(
            (level) => levels.indexOf(level) >= levels.indexOf(desired),
          );
    // Never silently choose a lower-than-requested level.
    if (!selected)
      return {
        ...base,
        status: 'unsupported',
        reason: 'requested-level-unavailable',
        evidence,
      };
    effective = selected;
    exact = selected === desired;
  } else if (budget) {
    if (input.intent === 'off')
      return {
        ...base,
        status: 'unsupported',
        reason: 'budget-off-not-declared',
        evidence,
      };
    const selected = budget.budgets[input.intent];
    if (
      !Number.isSafeInteger(selected) ||
      !Number.isSafeInteger(budget.minimum) ||
      budget.minimum < 0 ||
      !Number.isSafeInteger(budget.maximum) ||
      budget.maximum < budget.minimum ||
      !Number.isSafeInteger(budget.outputHeadroom) ||
      budget.outputHeadroom < 1 ||
      selected < budget.minimum ||
      selected > budget.maximum ||
      !Number.isSafeInteger(input.maxOutputTokens) ||
      selected + budget.outputHeadroom > (input.maxOutputTokens ?? 0)
    )
      return {
        ...base,
        status: 'unsupported',
        reason: 'invalid-budget-or-output-headroom',
        evidence,
      };
    effective = selected;
  } else if (toggle) {
    if (input.intent === 'off' && !toggle.canDisable)
      return {
        ...base,
        status: 'unsupported',
        reason: 'cannot-disable',
        evidence,
      };
    effective = input.intent !== 'off';
    exact = false;
  } else
    return {
      ...base,
      status: 'unknown',
      reason: 'empty-control-profile',
      evidence,
    };
  const status =
    evidence.source === 'tentative'
      ? 'tentative'
      : exact
        ? 'exact'
        : 'approximate';
  if (capability.encoding === 'portable') {
    if (typeof effective !== 'string' || effective === 'max')
      return {
        ...base,
        status: 'unsupported',
        reason: 'portable-encoding-unavailable',
        evidence,
      };
    return {
      ...base,
      status,
      effective,
      reasoning: effective,
      evidence,
      reason: 'portable-level',
    };
  }
  let generated: JSONObject;
  if (capability.encoding === 'compatible' && typeof effective === 'string')
    generated = { reasoningEffort: effective };
  else if (
    capability.encoding === 'anthropic-adaptive' &&
    typeof effective === 'string'
  )
    generated = { thinking: { type: 'adaptive' }, effort: effective };
  else if (
    capability.encoding === 'openrouter' &&
    typeof effective === 'string'
  )
    generated = { reasoning: { effort: effective } };
  else if (
    capability.encoding === 'anthropic-budget' &&
    typeof effective === 'number'
  )
    generated = { thinking: { type: 'enabled', budgetTokens: effective } };
  else if (
    capability.encoding === 'google-budget' &&
    typeof effective === 'number'
  )
    generated = { thinkingConfig: { thinkingBudget: effective } };
  else
    return {
      ...base,
      status: 'unsupported',
      reason: 'encoder-control-mismatch',
      evidence,
    };
  return {
    ...base,
    status,
    effective,
    evidence,
    reason: 'native-control',
    providerOptions: {
      ...providerOptions,
      [capability.namespace]: {
        ...providerOptions?.[capability.namespace],
        ...generated,
      },
    },
  };
}

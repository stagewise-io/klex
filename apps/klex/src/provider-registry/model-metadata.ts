import type {
  ModelMetadataProvenance,
  ProviderModel,
} from './provider-registry';

export type ProviderModelMetadata = Omit<ProviderModel, 'modelId'>;

export interface ModelMetadataRule {
  match: { exact: string } | { prefix: string };
  metadata: ProviderModelMetadata;
  provenance: ModelMetadataProvenance;
}

function mergeRecord(
  lower: Readonly<Record<string, unknown>> | undefined,
  higher: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!lower && !higher) return undefined;
  const result: Record<string, unknown> = { ...lower };
  for (const [key, value] of Object.entries(higher ?? {})) {
    const previous = result[key];
    result[key] =
      isRecord(previous) && isRecord(value)
        ? mergeRecord(previous, value)
        : structuredClone(value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeProvenance(
  ...groups: readonly (readonly ModelMetadataProvenance[])[]
): ModelMetadataProvenance[] {
  const seen = new Set<string>();
  return groups.flat().filter((entry) => {
    const key = `${entry.source}\u0000${entry.documentationUrl ?? ''}\u0000${entry.reviewedAt ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeProviderModels(
  ...models: readonly (ProviderModel | undefined)[]
): ProviderModel | undefined {
  let result: ProviderModel | undefined;
  for (const model of models) {
    if (!model) continue;
    const capabilities = mergeRecord(
      result?.capabilities,
      model.capabilities,
    ) as ProviderModel['capabilities'];
    result = {
      ...result,
      ...structuredClone(model),
      ...(capabilities && { capabilities }),
      provenance: mergeProvenance(
        result?.provenance ?? [],
        model.provenance ?? [],
      ),
    };
  }
  return result;
}

export function resolveMetadataRules(
  modelId: string,
  rules: readonly ModelMetadataRule[],
): ProviderModelMetadata | undefined {
  const matches = rules
    .filter((rule) =>
      'exact' in rule.match
        ? rule.match.exact === modelId
        : modelId.startsWith(rule.match.prefix),
    )
    .sort(
      (left, right) =>
        Number('exact' in left.match) - Number('exact' in right.match),
    );
  const resolved = mergeProviderModels(
    ...matches.map((rule) => ({
      modelId,
      ...rule.metadata,
      provenance: [...(rule.metadata.provenance ?? []), rule.provenance],
    })),
  );
  if (!resolved) return undefined;
  const { modelId: _modelId, ...metadata } = resolved;
  return metadata;
}

export function validateMetadataRules(
  rules: readonly ModelMetadataRule[],
): void {
  const exact = new Set<string>();
  for (const rule of rules) {
    const value = 'exact' in rule.match ? rule.match.exact : rule.match.prefix;
    if (!value.trim()) throw new Error('Model metadata match cannot be empty');
    if ('exact' in rule.match) {
      if (exact.has(value))
        throw new Error(`Duplicate exact model metadata rule '${value}'`);
      exact.add(value);
    }
    if (
      rule.provenance.documentationUrl &&
      !URL.canParse(rule.provenance.documentationUrl)
    ) {
      throw new Error(
        `Invalid model metadata documentation URL '${rule.provenance.documentationUrl}'`,
      );
    }
  }
}

import type {
  ModelMetadataRule,
  ProviderModelMetadata,
} from '../model-metadata';
import { mergeProviderModels, resolveMetadataRules } from '../model-metadata';
import { resolveOpenModelMetadata } from '../open-model-catalog';
import type { ProviderModel } from '../provider-registry';

const REVIEWED_AT = '2026-09-08';

export interface ModelFallbackRule {
  prefixes?: readonly string[];
  includesAny?: readonly string[];
  patterns?: readonly RegExp[];
  excludesAny?: readonly string[];
  metadata: ProviderModelMetadata;
  documentationUrl?: string;
}

/** Exact rules keep the provider's model ID casing for catalog fallbacks. */
export interface ExactModelRule extends ModelMetadataRule {
  modelId: string;
}

export function exactModel(
  modelId: string,
  metadata: ProviderModelMetadata,
  documentationUrl: string,
): ExactModelRule {
  return {
    modelId,
    match: { exact: modelId.toLowerCase() },
    metadata,
    provenance: {
      source: 'provider-exact',
      documentationUrl,
      reviewedAt: REVIEWED_AT,
    },
  };
}

/** Fallback list for failed discovery: exact chat and voice catalog entries. */
export function catalogModels(
  rules: readonly ExactModelRule[],
  resolve: (modelId: string) => ProviderModelMetadata | undefined,
): readonly ProviderModel[] {
  return rules.flatMap(({ modelId }) => {
    const metadata = resolve(modelId);
    return metadata && CATALOG_FALLBACK_KINDS.has(metadata.kind ?? 'unknown')
      ? [{ modelId, ...metadata }]
      : [];
  });
}

const CATALOG_FALLBACK_KINDS = new Set([
  'language',
  'speech-to-speech',
  'speech-to-text',
  'text-to-speech',
]);

export function modelFamily(
  prefix: string,
  metadata: ProviderModelMetadata,
  documentationUrl: string,
): ModelMetadataRule {
  return {
    match: { prefix },
    metadata,
    provenance: {
      source: 'provider-family',
      documentationUrl,
      reviewedAt: REVIEWED_AT,
    },
  };
}

export function resolveCatalogMetadata(
  modelId: string,
  rules: readonly ModelMetadataRule[],
  canonicalOpenModelId?: string,
  fallbacks: readonly ModelFallbackRule[] = [],
): ProviderModelMetadata | undefined {
  const provider =
    resolveMetadataRules(modelId.toLowerCase(), rules) ??
    resolveFallbackMetadata(modelId, fallbacks);
  const shared = resolveOpenModelMetadata(canonicalOpenModelId);
  const merged = mergeProviderModels(
    shared ? { modelId, ...shared } : undefined,
    provider ? { modelId, ...provider } : undefined,
  );
  if (!merged) return undefined;
  const { modelId: _modelId, ...metadata } = merged;
  return metadata;
}

function resolveFallbackMetadata(
  modelId: string,
  rules: readonly ModelFallbackRule[],
): ProviderModelMetadata | undefined {
  const normalized = modelId.toLowerCase();
  const rule = rules.find(
    ({ prefixes, includesAny, patterns, excludesAny }) =>
      (!prefixes ||
        prefixes.some((prefix) =>
          normalized.startsWith(prefix.toLowerCase()),
        )) &&
      (!includesAny ||
        includesAny.some((part) => normalized.includes(part.toLowerCase()))) &&
      (!patterns || patterns.some((pattern) => pattern.test(normalized))) &&
      (!excludesAny ||
        excludesAny.every((part) => !normalized.includes(part.toLowerCase()))),
  );
  if (!rule) return undefined;
  return {
    ...structuredClone(rule.metadata),
    provenance: [
      ...(rule.metadata.provenance ?? []),
      {
        source: 'provider-family',
        ...(rule.documentationUrl && {
          documentationUrl: rule.documentationUrl,
        }),
        reviewedAt: REVIEWED_AT,
      },
    ],
  };
}

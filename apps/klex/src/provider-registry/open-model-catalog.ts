import type {
  ModelMetadataRule,
  ProviderModelMetadata,
} from './model-metadata';
import { resolveMetadataRules } from './model-metadata';

const REVIEWED_AT = '2026-09-08';

function openExactModels(
  modelIds: readonly string[],
  metadata: ProviderModelMetadata,
  documentationUrl: string,
): ModelMetadataRule[] {
  return modelIds.map((modelId) => ({
    match: { exact: modelId.toLowerCase() },
    metadata,
    provenance: {
      source: 'shared-catalog',
      documentationUrl,
      reviewedAt: REVIEWED_AT,
    },
  }));
}

const OPEN_MODEL_RULES = [
  ...openExactModels(
    ['gpt-oss-120b', 'openai/gpt-oss-120b'],
    { kind: 'language', displayName: 'gpt-oss-120b', contextSize: 131_072 },
    'https://developers.openai.com/api/docs/models/gpt-oss-120b',
  ),
  ...openExactModels(
    ['gpt-oss-20b', 'openai/gpt-oss-20b'],
    { kind: 'language', displayName: 'gpt-oss-20b', contextSize: 131_072 },
    'https://developers.openai.com/api/docs/models/gpt-oss-20b',
  ),
  ...openExactModels(
    ['shieldstral-1.0-3b', 'mistralai/shieldstral-1.0-3b'],
    {
      kind: 'moderation',
      displayName: 'Shieldstral 1.0 3B',
      contextSize: 32_768,
      capabilities: { input: { image: {} } },
    },
    'https://docs.mistral.ai/models/shieldstral-1-0',
  ),
  ...(
    [
      ['gemma-3-270m', 32_768, false],
      ['gemma-3-1b', 32_768, false],
      ['gemma-3-4b', 131_072, true],
      ['gemma-3-12b', 131_072, true],
      ['gemma-3-27b', 131_072, true],
    ] as const
  ).flatMap(([modelId, contextSize, image]) =>
    openExactModels(
      [modelId, `google/${modelId}`],
      {
        kind: 'language',
        displayName: modelId,
        contextSize,
        ...(image && { capabilities: { input: { image: {} } } }),
      },
      'https://ai.google.dev/gemma/docs/core/model_card_3',
    ),
  ),
  ...(
    [
      ['gemma-3n-e2b', 'Gemma 3n E2B'],
      ['gemma-3n-e4b', 'Gemma 3n E4B'],
    ] as const
  ).flatMap(([modelId, displayName]) =>
    openExactModels(
      [modelId, `google/${modelId}`],
      {
        kind: 'language',
        displayName,
        contextSize: 32_768,
        capabilities: { input: { image: {}, audio: {} } },
      },
      'https://ai.google.dev/gemma/docs/gemma-3n',
    ),
  ),
  ...(
    [
      ['gemma-4-e2b', 'Gemma 4 E2B', 131_072, true],
      ['gemma-4-e4b', 'Gemma 4 E4B', 131_072, true],
      ['gemma-4-12b', 'Gemma 4 12B', 262_144, true],
      ['gemma-4-26b-a4b', 'Gemma 4 26B A4B', 262_144, false],
      ['gemma-4-31b', 'Gemma 4 31B', 262_144, false],
    ] as const
  ).flatMap(([modelId, displayName, contextSize, audio]) =>
    openExactModels(
      [modelId, `google/${modelId}`],
      {
        kind: 'language',
        displayName,
        contextSize,
        capabilities: {
          input: {
            image: {},
            ...(audio && { audio: { maxLengthSeconds: 30 } }),
          },
        },
      },
      'https://ai.google.dev/gemma/docs/core/model_card_4',
    ),
  ),
  ...(
    [
      ['lfm2.5-1.2b-instruct', 32_768, false, false],
      ['lfm2.5-1.2b-thinking', 32_768, false, false],
      ['lfm2.5-1.2b-jp', 32_768, false, false],
      ['lfm2.5-350m', 32_768, false, false],
      ['lfm2.5-230m', 32_768, false, false],
      ['lfm2.5-2.6b', 32_768, false, false],
      ['lfm2.5-8b-a1b', 131_072, false, false],
      ['lfm2-24b-a2b', 32_768, false, false],
      ['lfm2-700m', 32_768, false, false],
      ['lfm2-350m-enjp-mt', 32_768, false, false],
      ['lfm2-350m-math', 32_768, false, false],
      ['lfm2-350m-pii-extract-jp', 32_768, false, false],
      ['lfm2-2.6b-transcript', 32_768, false, false],
      ['lfm2.5-vl-3b', 32_768, true, false],
      ['lfm2.5-vl-1.6b', 32_768, true, false],
      ['lfm2.5-vl-450m', 32_768, true, false],
      ['lfm2.5-vl-1.6b-extract', 32_768, true, false],
      ['lfm2.5-vl-450m-extract', 32_768, true, false],
      ['lfm2.5-audio-1.5b', 32_768, false, true],
      ['lfm2.5-audio-1.5b-jp', 32_768, false, true],
      ['lfm2-audio-1.5b', 32_768, false, true],
    ] as const
  ).flatMap(([modelId, contextSize, image, audio]) =>
    openExactModels(
      [modelId, `liquidai/${modelId}`],
      {
        kind: 'language',
        displayName: modelId,
        contextSize,
        ...((image || audio) && {
          capabilities: {
            input: {
              ...(image && { image: {} }),
              ...(audio && { audio: {} }),
            },
          },
        }),
      },
      'https://docs.liquid.ai/lfm/models/complete-library',
    ),
  ),
];

export function resolveOpenModelMetadata(
  modelId: string | undefined,
): ProviderModelMetadata | undefined {
  if (!modelId) return undefined;
  const candidates = modelIdCandidates(modelId);
  const matchedId = OPEN_MODEL_RULES.flatMap((rule) =>
    'exact' in rule.match ? [rule.match.exact] : [],
  )
    .filter((catalogId) =>
      candidates.some((candidate) => matchesCatalogId(candidate, catalogId)),
    )
    .sort((left, right) => right.length - left.length)[0];
  return matchedId
    ? resolveMetadataRules(matchedId, OPEN_MODEL_RULES)
    : undefined;
}

function modelIdCandidates(modelId: string): string[] {
  const normalized = modelId
    .trim()
    .toLowerCase()
    .replace(/:(\d+(?:\.\d+)?b)(?=$|[-:@])/g, '-$1');
  const segments = normalized.split('/').filter(Boolean);
  return [...new Set([normalized, segments.at(-1)].filter(isString))];
}

function matchesCatalogId(candidate: string, catalogId: string): boolean {
  if (candidate === catalogId) return true;
  const suffix = candidate.slice(catalogId.length);
  return (
    candidate.startsWith(catalogId) &&
    /^(?:[:@][a-z0-9._-]+|-(?:chat|free|instruct|it|latest|q\d|fp\d|int\d)(?:$|[-:@]))/.test(
      suffix,
    )
  );
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

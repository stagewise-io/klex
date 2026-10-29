import type { JsonMigration } from '@/local-data';

import {
  type ApiFormat,
  type KlexConfigV4,
  klexConfigV4Schema,
  type LegacyEndpointAuth,
  type LegacyModelEntry,
  type LegacyProviderConfig,
  type ModelSelectionEntry,
  parseLegacyKlexConfig,
  parseStoredKlexConfigV2,
} from './config-contracts';

export const configV1V2: JsonMigration = {
  from: 1,
  to: 2,
  name: 'unify-model-provider-registry',
  up: (value) =>
    value.configVersion === 2
      ? parseStoredKlexConfigV2(value)
      : migrateLegacyKlexConfig(value),
};

export function migrateLegacyKlexConfig(input: unknown): KlexConfigV4 {
  const legacy = parseLegacyKlexConfig(input);
  const providers: KlexConfigV4['providers'] = {};
  const providerIds = new Map<string, Map<string | undefined, string>>();
  for (const [oldProviderId, provider] of Object.entries(legacy.providers)) {
    const ids = new Map<string, string>();
    if ('preset' in provider) {
      addMigratedProvider(providers, oldProviderId, {
        type: provider.preset === 'google' ? 'google-gemini' : provider.preset,
        settings: legacySettings(provider.auth),
        knownModels: provider.knownModels,
      });
      providerIds.set(oldProviderId, new Map([[undefined, oldProviderId]]));
      continue;
    }
    const entries = Object.entries(provider.endpoints);
    for (const [endpointId, endpoint] of entries) {
      const instanceId =
        entries.length === 1
          ? oldProviderId
          : `${oldProviderId}--${endpointId}`;
      addMigratedProvider(providers, instanceId, {
        type: legacyFormatProviderType(endpoint.format),
        settings: { baseUrl: endpoint.url, ...legacySettings(endpoint.auth) },
        knownModels: endpoint.knownModels,
      });
      ids.set(endpointId, instanceId);
    }
    providerIds.set(oldProviderId, ids);
  }
  const migrateList = (entries: readonly LegacyModelEntry[]) =>
    entries.map((entry) =>
      migrateLegacyModelEntry(entry, legacy.providers, providerIds),
    );
  const selection = legacy.modelSelection;
  return klexConfigV4Schema.parse({
    configVersion: 2,
    episodeFinishIdleTriggerTimeMs: legacy.episodeFinishIdleTriggerTimeMs,
    officialName: legacy.officialName,
    providers,
    modelSelection: {
      chat: migrateList(selection.chat),
      compaction: migrateList(selection.compaction),
      memory: migrateList(selection.memory),
      imageVision: migrateList(selection.imageVision),
      audioListening: migrateList(selection.audioListening),
      consult: migrateList(selection.consult),
      voice: {
        sts: migrateList(selection.voice.sts),
        tts: migrateList(selection.voice.tts),
        stt: migrateList(selection.voice.stt),
      },
    },
    mcpServers: legacy.mcpServers,
  });
}

function migrateLegacyModelEntry(
  entry: LegacyModelEntry,
  providers: Record<string, LegacyProviderConfig>,
  providerIds: ReadonlyMap<string, ReadonlyMap<string | undefined, string>>,
): ModelSelectionEntry {
  const encoded = typeof entry === 'string' ? entry : entry.model;
  const separator = encoded.indexOf(':');
  const oldProviderId = encoded.slice(0, separator);
  const remainder = encoded.slice(separator + 1);
  const provider = providers[oldProviderId];
  const ids = providerIds.get(oldProviderId);
  if (!provider || !ids)
    throw new Error(
      `Unknown provider '${oldProviderId}' in legacy model reference`,
    );
  let providerId: string | undefined;
  let modelId = remainder;
  if ('preset' in provider) {
    providerId = ids.get(undefined);
  } else {
    const endpointSeparator = remainder.indexOf(':');
    if (endpointSeparator === -1)
      throw new Error(
        `Legacy model reference '${encoded}' is missing an endpoint`,
      );
    providerId = ids.get(remainder.slice(0, endpointSeparator));
    modelId = remainder.slice(endpointSeparator + 1);
  }
  if (!providerId || !modelId)
    throw new Error(`Invalid legacy model reference '${encoded}'`);
  return {
    providerId,
    modelId,
    ...(typeof entry === 'object' && entry.providerOptions
      ? { providerOptions: entry.providerOptions }
      : {}),
  };
}

function addMigratedProvider(
  providers: KlexConfigV4['providers'],
  providerId: string,
  provider: KlexConfigV4['providers'][string],
): void {
  if (providers[providerId])
    throw new Error(`Provider migration ID collision at '${providerId}'`);
  providers[providerId] = provider;
}

function legacySettings(auth: LegacyEndpointAuth): Record<string, unknown> {
  return {
    ...(auth.apiKey !== undefined && {
      apiKey: migrateLegacyEnvironmentReferences(auth.apiKey),
    }),
    ...(auth.headers !== undefined && {
      headers: Object.fromEntries(
        Object.entries(auth.headers).map(([key, value]) => [
          key,
          migrateLegacyEnvironmentReferences(value),
        ]),
      ),
    }),
  };
}

function migrateLegacyEnvironmentReferences(value: string): string {
  return value.replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${env:$1}');
}

function legacyFormatProviderType(
  format: ApiFormat,
): KlexConfigV4['providers'][string]['type'] {
  switch (format) {
    case 'openai':
      return 'openai';
    case 'chat-completions':
      return 'chat-completions';
    case 'anthropic':
    case 'messages':
      return 'anthropic-messages';
    case 'google':
      return 'google-generative';
    case 'open-responses':
      return 'responses';
    case 'realtime':
    case 'speech':
    case 'transcriptions':
      return 'openai';
  }
}

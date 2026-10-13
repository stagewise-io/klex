import { parseDocument } from 'yaml';

import type {
  ProviderInstance,
  ProviderOperationResult,
  ProviderVoice,
  ProviderVoiceList,
} from '../provider-registry';
import {
  available,
  customHeaders,
  isRecord,
  setting,
  unavailable,
} from './shared';

const OPENAI_SCHEMA_URL =
  'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml';
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
// Translate/transcription variants have different output contracts; intentionally excluded.
const GEMINI_MODELS = new Set([
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-2.5-flash-native-audio-preview-09-2025',
]);

export function openAiVoiceProfile(
  modelId: string,
): 'live' | 'realtime' | undefined {
  const live = /^gpt-live-1(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId);
  const realtime =
    /^(?:gpt-realtime(?:-(?:2\.1-mini|2\.1|2|1\.5|mini))?|gpt-4o(?:-mini)?-realtime-preview)(?:-\d{4}-\d{2}-\d{2})?$/.test(
      modelId,
    );
  return live ? 'live' : realtime ? 'realtime' : undefined;
}

/** Public metadata only. Registry-owned list caching supplies last-good fallback. */
export async function discoverOpenAiVoices(
  modelId: string,
  signal: AbortSignal,
): Promise<ProviderOperationResult<ProviderVoiceList>> {
  const profile = openAiVoiceProfile(modelId);
  if (!profile) return available({ voices: [] });
  try {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    const response = await fetch(OPENAI_SCHEMA_URL, {
      signal: requestSignal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable(
        'discovery_failed',
        `OpenAI schema returned HTTP ${response.status}`,
      );
    }
    const source = await readSchema(response, requestSignal);
    const document = parseDocument(source);
    if (document.errors.length) throw new Error('Malformed schema');
    const body: unknown = document.toJS({ maxAliasCount: 0 });
    if (
      !isRecord(body) ||
      typeof body.openapi !== 'string' ||
      !body.openapi.startsWith('3.') ||
      !isRecord(body.components) ||
      !isRecord(body.components.schemas)
    )
      throw new Error('Missing schemas');
    const schemas = body.components.schemas;
    const output = schemas.LiveInitialSessionAudioOutputParam;
    const root =
      profile === 'live'
        ? isRecord(output) && isRecord(output.properties)
          ? output.properties.voice
          : undefined
        : schemas.VoiceIdsShared;
    const ids = schemaVoiceIds(root, schemas);
    requestSignal.throwIfAborted();
    return available({
      ...(!modelId.startsWith('gpt-4o') &&
        ids.includes('marin') && { defaultVoiceId: 'marin' }),
      voices: ids.map((voiceId) => ({
        voiceId,
        displayName: voiceId,
        isPreviewAvailable: true,
      })),
    });
  } catch {
    return unavailable(
      'discovery_failed',
      signal.aborted
        ? 'Voice discovery cancelled'
        : 'Could not load OpenAI voice options from the published schema',
    );
  }
}

async function readSchema(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (
    Number(response.headers.get('content-length')) > MAX_SCHEMA_BYTES ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error('Invalid schema size');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SCHEMA_BYTES) throw new Error('Schema too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function schemaVoiceIds(
  root: unknown,
  schemas: Record<string, unknown>,
): string[] {
  const ids = new Set<string>();
  let visits = 0;
  const walk = (node: unknown, ancestors: Set<unknown>) => {
    if (
      !isRecord(node) ||
      ancestors.has(node) ||
      ancestors.size >= 32 ||
      ++visits > 1024
    )
      throw new Error('Invalid voice schema');
    const next = new Set(ancestors).add(node);
    if (node.enum !== undefined) {
      if (
        !Array.isArray(node.enum) ||
        !node.enum.length ||
        node.enum.length > 256
      )
        throw new Error('Invalid voice enum');
      for (const id of node.enum) {
        if (
          typeof id !== 'string' ||
          !/^[a-z][a-z0-9_-]{0,63}$/.test(id) ||
          id.startsWith('voice_')
        )
          throw new Error('Invalid built-in voice ID');
        ids.add(id);
      }
    }
    if (node.$ref !== undefined) {
      if (
        typeof node.$ref !== 'string' ||
        !node.$ref.startsWith('#/components/schemas/')
      )
        throw new Error('Unsupported schema reference');
      const name = decodeURIComponent(
        node.$ref.slice('#/components/schemas/'.length),
      )
        .replace(/~1/g, '/')
        .replace(/~0/g, '~');
      if (!Object.hasOwn(schemas, name))
        throw new Error('Missing schema reference');
      walk(schemas[name], next);
    }
    // Do not walk object properties: custom-voice IDs are not built-in options.
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (node[key] === undefined) continue;
      if (!Array.isArray(node[key]))
        throw new Error('Invalid schema alternatives');
      for (const branch of node[key]) walk(branch, next);
    }
  };
  walk(root, new Set());
  if (!ids.size || ids.size > 256) throw new Error('Missing voice enum');
  return [...ids];
}

export function isGeminiVoiceModel(modelId: string): boolean {
  return GEMINI_MODELS.has(modelId.replace(/^models\//, ''));
}

export function isGeminiVoiceId(voiceId: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(voiceId) &&
    !voiceId.startsWith('voice_') &&
    !voiceId.startsWith('voicekey_')
  );
}

export async function discoverGeminiVoices(
  instance: ProviderInstance,
  modelId: string,
  signal: AbortSignal,
): Promise<ProviderOperationResult<ProviderVoiceList>> {
  if (!isGeminiVoiceModel(modelId)) return available({ voices: [] });
  const apiKey = setting(instance, 'apiKey');
  if (!apiKey)
    return unavailable('authentication_required', 'Configure a Gemini API key');
  const voices = new Map<string, ProviderVoice>();
  const tokens = new Set<string>();
  let pageToken = '';
  let pages = 0;
  try {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    do {
      requestSignal.throwIfAborted();
      if (++pages > 100)
        return unavailable(
          'discovery_failed',
          'Voice catalog has too many pages',
        );
      const url = new URL(
        `${(setting(instance, 'baseUrl') ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/voices`,
      );
      url.searchParams.set('type', 'prebuilt');
      url.searchParams.set('page_size', '1000');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const response = await fetch(url, {
        signal: requestSignal,
        redirect: 'error',
        headers: { ...customHeaders(instance), 'x-goog-api-key': apiKey },
      });
      if (!response.ok) await response.body?.cancel();
      if ([401, 403].includes(response.status))
        return unavailable(
          'authentication_required',
          'Gemini rejected the configured credentials or voice catalog access',
        );
      if (response.status === 400)
        return unavailable(
          'invalid_configuration',
          'Gemini rejected the voice discovery configuration',
        );
      if (!response.ok)
        return unavailable(
          'discovery_failed',
          `Voice catalog returned HTTP ${response.status}`,
        );
      let body: unknown;
      try {
        body = JSON.parse(await readSchema(response, requestSignal));
      } catch {
        return unavailable('discovery_failed', 'Malformed voice catalog');
      }
      if (
        !isRecord(body) ||
        (body.voices !== undefined && !Array.isArray(body.voices))
      )
        return unavailable('discovery_failed', 'Malformed voice catalog');
      for (const item of (body.voices ?? []) as unknown[]) {
        if (!isRecord(item))
          return unavailable('discovery_failed', 'Malformed voice catalog');
        if (item.type !== 'prebuilt') continue;
        if (typeof item.id !== 'string' || !isGeminiVoiceId(item.id))
          return unavailable('discovery_failed', 'Invalid prebuilt voice ID');
        voices.set(item.id, {
          voiceId: item.id,
          displayName:
            typeof item.display_name === 'string' ? item.display_name : item.id,
          ...(typeof item.description === 'string'
            ? { description: item.description }
            : typeof item.persona === 'string' && {
                description: item.persona,
              }),
          isPreviewAvailable: true,
        });
        if (voices.size > 10_000)
          return unavailable('discovery_failed', 'Voice catalog too large');
      }
      if (
        body.next_page_token !== undefined &&
        typeof body.next_page_token !== 'string'
      )
        return unavailable(
          'discovery_failed',
          'Malformed voice catalog pagination',
        );
      pageToken = (body.next_page_token as string | undefined) ?? '';
      if (pageToken && tokens.has(pageToken))
        return unavailable(
          'discovery_failed',
          'Voice catalog pagination did not terminate',
        );
      tokens.add(pageToken);
    } while (pageToken);
    requestSignal.throwIfAborted();
    if (!voices.size)
      return unavailable('discovery_failed', 'Missing prebuilt voices');
    return available({
      voices: [...voices.values()],
    });
  } catch {
    if (signal.aborted)
      return unavailable('discovery_failed', 'Voice discovery cancelled');
    return unavailable(
      'discovery_failed',
      'Could not load Gemini voice options',
    );
  }
}

import type { FilePart, ImagePart, TextPart } from 'ai';

import { prepareRemoteInput } from '@/provider-registry/remote-input';
import { describeMediaContent } from '@/shared-utilities/tool-result';

import type { ExtensionDeps, ResolvedModel } from '../extension-api';

export type AdaptationModel = Pick<
  ResolvedModel,
  'modelId' | 'inputCapabilities' | 'reference'
>;

export const normalizeMediaType = (value: string): string =>
  value.split(';', 1)[0]!.trim().toLowerCase();

const aliases: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
};

function unwrap(data: unknown): unknown {
  if (data && typeof data === 'object' && 'type' in data) {
    if (data.type === 'url' && 'url' in data) return data.url;
    if (data.type === 'data' && 'data' in data) return data.data;
  }
  return data;
}

function referenceUrl(data: unknown): string | undefined {
  data = unwrap(data);
  const value = data instanceof URL ? data.href : data;
  return typeof value === 'string' &&
    /^[a-z][a-z\d+.-]*:\/\//i.test(value) &&
    !value.startsWith('data:')
    ? value
    : undefined;
}

/** Reject references that would cause SDK downloads or violate explicit subtype limits. */
export async function adaptRemoteMedia(
  part: FilePart | ImagePart,
  deps: ExtensionDeps,
  model: AdaptationModel,
  family: 'image' | 'audio',
): Promise<FilePart | ImagePart | null> {
  let mediaType =
    part.type === 'file' ? normalizeMediaType(part.mediaType) : part.mediaType;
  const types = model.inputCapabilities[family]?.mediaTypes;
  if (
    mediaType &&
    types &&
    mediaType.includes('/') &&
    !types.includes(mediaType)
  ) {
    mediaType = aliases[mediaType] ?? mediaType;
    if (!types.includes(mediaType)) return null;
  }
  const url = referenceUrl(part.type === 'file' ? part.data : part.image);
  if (
    model.reference &&
    typeof deps.modelResolver?.getLanguageModel === 'function'
  ) {
    if (!url) return null;
    try {
      const result = await prepareRemoteInput(
        deps.modelResolver.getLanguageModel(model.reference),
        model.inputCapabilities,
        { url, mediaType },
      );
      if (result.type !== 'content') return null;
      mediaType = result.value[0].mediaType;
    } catch {
      return null;
    }
  }
  return part.type === 'file'
    ? { ...part, mediaType: mediaType ?? part.mediaType }
    : { ...part, ...(mediaType ? { mediaType } : {}) };
}

const textTypes = new Set([
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/graphql',
  'application/x-sh',
  'application/x-www-form-urlencoded',
]);

function decodeBytes(data: Uint8Array | ArrayBuffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

function inlineText(data: unknown): string | null {
  data = unwrap(data);
  if (
    data &&
    typeof data === 'object' &&
    'type' in data &&
    data.type === 'text' &&
    'text' in data &&
    typeof data.text === 'string'
  )
    return data.text;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer)
    return decodeBytes(data);
  if (data instanceof URL) data = data.href;
  if (typeof data !== 'string' || referenceUrl(data)) return null;
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',');
    if (comma < 0) return null;
    const payload = data.slice(comma + 1);
    if (/;base64$/i.test(data.slice(0, comma)))
      return decodeBytes(Buffer.from(payload, 'base64'));
    try {
      return decodeURIComponent(payload);
    } catch {
      return payload;
    }
  }
  if (
    data.length > 0 &&
    data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') === data) {
      const decoded = decodeBytes(bytes);
      if (decoded !== null) return decoded;
    }
  }
  return data.includes('\0') ? null : data;
}

/** Project historical attachments for a target without mutating canonical history. */
export async function adaptFilePart(
  part: FilePart,
  role: string,
  deps: ExtensionDeps,
  model: AdaptationModel,
  compaction: boolean,
): Promise<FilePart | TextPart> {
  const mediaType = normalizeMediaType(part.mediaType);
  const fallback: TextPart = { type: 'text', text: describeMediaContent(part) };
  const data = part.data as unknown;
  const taggedText =
    data && typeof data === 'object' && 'type' in data && data.type === 'text';
  if (
    taggedText ||
    mediaType.startsWith('text/') ||
    /application\/(?:json|xml)$|\+(?:json|xml)$/.test(mediaType) ||
    textTypes.has(mediaType)
  ) {
    const text = inlineText(data);
    if (text !== null) return text ? { type: 'text', text } : fallback;
    if (!referenceUrl(data)) return fallback;
  }
  if (compaction || role === 'assistant') return fallback;
  const url = referenceUrl(data);
  if (url) {
    if (
      !model.reference ||
      typeof deps.modelResolver?.getLanguageModel !== 'function'
    )
      return fallback;
    try {
      const result = await prepareRemoteInput(
        deps.modelResolver.getLanguageModel(model.reference),
        model.inputCapabilities,
        { url, mediaType },
      );
      return result.type === 'content'
        ? { ...part, mediaType: result.value[0].mediaType }
        : fallback;
    } catch {
      return fallback;
    }
  }
  if (mediaType === 'application/pdf') return { ...part, mediaType };
  if (
    model.reference &&
    typeof deps.modelResolver?.resolveModel === 'function'
  ) {
    try {
      const provider = deps.modelResolver.resolveModel(
        model.reference,
      ).providerType;
      if (
        role === 'user' &&
        mediaType.startsWith('video/') &&
        [
          'google-gemini',
          'google-generative',
          'google-vertex',
          'openai-compatible',
        ].includes(provider)
      )
        return { ...part, mediaType };
      if (
        provider === 'amazon-bedrock' &&
        [
          'text/plain',
          'text/csv',
          'text/html',
          'text/markdown',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'video/x-matroska',
          'video/quicktime',
          'video/mp4',
          'video/webm',
          'video/x-flv',
          'video/mpeg',
          'video/mpg',
          'video/wmv',
          'video/x-ms-wmv',
          'video/3gpp',
        ].includes(mediaType)
      )
        return { ...part, mediaType };
    } catch {
      return fallback;
    }
  }
  return fallback;
}

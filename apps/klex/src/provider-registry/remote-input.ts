import type {
  LanguageModelV4,
  LanguageModelV4FilePart,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import type { ToolResultPart } from 'ai';

import type { ModelInputCapabilities, ProviderType } from '@/config';

export const REMOTE_INPUT_UNAVAILABLE =
  'Remote media unavailable or unsupported.';

export const REMOTE_INPUT_REJECTED =
  'Remote media could not be fetched by the model provider.';

/** JSON-safe tool output. URLs are private content, never diagnostic text. */
export type RemoteInputResult =
  | {
      type: 'error-text';
      value: typeof REMOTE_INPUT_UNAVAILABLE | typeof REMOTE_INPUT_REJECTED;
    }
  | {
      type: 'content';
      value: [
        { type: 'file'; mediaType: string; data: { type: 'url'; url: string } },
      ];
    };

export const remoteInputUnavailable = (): RemoteInputResult => ({
  type: 'error-text',
  value: REMOTE_INPUT_UNAVAILABLE,
});

/** The provider rejected a request carrying this media; it is no longer sent. */
export const remoteInputRejected = (): RemoteInputResult => ({
  type: 'error-text',
  value: REMOTE_INPUT_REJECTED,
});

const extensionMediaTypes = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['pdf', 'application/pdf'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg'],
  ['flac', 'audio/flac'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['mpeg', 'video/mpeg'],
  ['mpg', 'video/mpeg'],
  ['m4v', 'video/mp4'],
  ['avi', 'video/avi'],
  ['flv', 'video/x-flv'],
  ['wmv', 'video/wmv'],
  ['3gp', 'video/3gpp'],
  ['bmp', 'image/bmp'],
]);

/**
 * Common non-canonical names for types that providers declare under another
 * name. Tried only when the original type matches no provider rule.
 */
const mediaTypeAliases = new Map([
  ['video/x-msvideo', 'video/avi'],
  ['video/msvideo', 'video/avi'],
  ['video/x-ms-wmv', 'video/wmv'],
  ['audio/x-wav', 'audio/wav'],
  ['audio/wave', 'audio/wav'],
  ['audio/mp3', 'audio/mpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
]);

function candidateMediaTypes(mediaType: string): string[] {
  const alias = mediaTypeAliases.get(mediaType);
  return alias && alias !== mediaType ? [mediaType, alias] : [mediaType];
}

function inferMediaType(url: URL): string | undefined {
  // pathname excludes query/fragment. Inspect only the final filename, without
  // percent-decoding or treating a bare dotfile as an extension.
  const filename = url.pathname.split('/').at(-1) ?? '';
  const dot = filename.lastIndexOf('.');
  return dot > 0
    ? extensionMediaTypes.get(filename.slice(dot + 1).toLowerCase())
    : undefined;
}

/**
 * Pure capability check: no HEAD, fetch, inference request, or byte inspection.
 *
 * The provider adapter's `supportedUrls` is the source of truth for accepted
 * media types, and must stay a hard gate: URLs it doesn't match would be
 * downloaded inside Klex by the AI SDK. Klex only infers a type from the file
 * extension when none is given, and falls back to a canonical alias when the
 * original type matches no provider rule. The first matching type is sent.
 */
export async function prepareRemoteInput(
  model: LanguageModelV4,
  capabilities: ModelInputCapabilities,
  input: { url: string; mediaType?: string },
): Promise<RemoteInputResult> {
  try {
    const url = new URL(input.url);
    const mediaType =
      input.mediaType === undefined
        ? inferMediaType(url)
        : input.mediaType.toLowerCase();
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !/^https?:\/\//i.test(input.url) ||
      /[\s\\]/.test(input.url) ||
      url.username ||
      url.password ||
      input.url !== input.url.trim() ||
      !mediaType ||
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
        mediaType,
      )
    ) {
      return remoteInputUnavailable();
    }
    const supportedUrls = await model.supportedUrls;
    const accepted = candidateMediaTypes(mediaType).find((candidate) => {
      const family = candidate.split('/')[0];
      if (family === 'image' || family === 'audio') {
        const capability = capabilities[family];
        if (
          !capability ||
          (capability.mediaTypes && !capability.mediaTypes.includes(candidate))
        ) {
          return false;
        }
      }
      return Object.entries(supportedUrls).some(
        ([type, patterns]) =>
          (type === '*' ||
            type === '*/*' ||
            type === candidate ||
            type === `${family}/*`) &&
          patterns.some((pattern) =>
            new RegExp(pattern.source, pattern.flags).test(
              url.href.toLowerCase(),
            ),
          ),
      );
    });
    if (!accepted) return remoteInputUnavailable();
    return {
      type: 'content',
      value: [
        {
          type: 'file',
          mediaType: accepted,
          data: { type: 'url', url: url.href },
        },
      ],
    };
  } catch {
    return remoteInputUnavailable();
  }
}

export function remoteInputModelOutput(
  result: RemoteInputResult,
): ToolResultPart['output'] {
  if (result.type === 'error-text') return result;
  const file = result.value[0];
  return {
    type: 'content',
    value: [{ ...file, data: { type: 'url', url: new URL(file.data.url) } }],
  };
}

/**
 * Google only accepts inline bytes inside functionResponse. Carry remote files
 * as adjacent native user input instead, keeping the tool result paired with its
 * call. Other adapters already map supported tool URLs natively (Responses,
 * Anthropic), or declare no supported HTTP URLs (compatible chat, Bedrock).
 */
export function withRemoteInputMapping(
  model: LanguageModelV4,
  type: ProviderType,
): LanguageModelV4 {
  if (!['google-gemini', 'google-generative', 'google-vertex'].includes(type))
    return model;
  const map = (prompt: LanguageModelV4Prompt): LanguageModelV4Prompt =>
    prompt.flatMap((message): LanguageModelV4Prompt => {
      if (message.role !== 'tool') return [message];
      const files: LanguageModelV4FilePart[] = [];
      const content = message.content.map((part) => {
        if (part.type !== 'tool-result' || part.output.type !== 'content')
          return part;
        const value = part.output.value.filter((item) => {
          if (item.type !== 'file' || item.data.type !== 'url') return true;
          files.push(item);
          return false;
        });
        return {
          ...part,
          output: {
            type: 'content' as const,
            value: value.length
              ? value
              : [{ type: 'text' as const, text: 'Remote media supplied.' }],
          },
        };
      });
      return [
        { ...message, content },
        ...(files.length ? [{ role: 'user' as const, content: files }] : []),
      ];
    });
  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    get supportedUrls() {
      return model.supportedUrls;
    },
    doGenerate: (options) =>
      model.doGenerate({ ...options, prompt: map(options.prompt) }),
    doStream: (options) =>
      model.doStream({ ...options, prompt: map(options.prompt) }),
  };
}

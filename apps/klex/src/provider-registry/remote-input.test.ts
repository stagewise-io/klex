import { readFile, writeFile } from 'node:fs/promises';

import { generateText, type ModelMessage, streamText } from 'ai';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import type { ProviderType } from '@/config';
import { classifyGenerationError } from '@/utils/llm';

import { builtInProviderDefinitions } from './providers/providers';
import {
  prepareRemoteInput,
  remoteInputModelOutput,
  remoteInputUnavailable,
  withRemoteInputMapping,
} from './remote-input';

const url = 'https://media.example/private?signature=secret';
const capabilities = { image: {}, audio: {} };

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async () =>
    JSON.stringify({ tokens: { access_token: 'test-token' } }),
  ),
  writeFile: vi.fn(() => {
    throw new Error('Unexpected filesystem write');
  }),
}));

function model(type: ProviderType, modelId = 'gemini-2.5-pro') {
  const definition = builtInProviderDefinitions.find(
    (item) => item.type === type,
  );
  assert(definition);
  return withRemoteInputMapping(
    definition.createLanguageModel(
      {
        id: 'test',
        type,
        settings: {
          apiKey: 'key',
          baseUrl: 'https://provider.example/v1',
          resourceName: 'resource',
          authMode: 'api-key',
          project: 'project',
          region: 'us-east-1',
        },
      },
      modelId,
    ),
    type,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('remote input capability contract', () => {
  it.each([
    ['JpG', 'image/jpeg'],
    ['JPEG', 'image/jpeg'],
    ['PnG', 'image/png'],
    ['GIF', 'image/gif'],
    ['WebP', 'image/webp'],
    ['AVIF', 'image/avif'],
    ['PdF', 'application/pdf'],
    ['MP3', 'audio/mpeg'],
    ['WaV', 'audio/wav'],
    ['OGG', 'audio/ogg'],
    ['FLAC', 'audio/flac'],
    ['M4A', 'audio/mp4'],
    ['AAC', 'audio/aac'],
    ['Mp4', 'video/mp4'],
    ['WEBM', 'video/webm'],
    ['MOV', 'video/quicktime'],
    ['MPEG', 'video/mpeg'],
    ['MPG', 'video/mpeg'],
  ])('infers %s as %s without I/O', async (extension, mediaType) => {
    const fetch = vi.fn(() => {
      throw new Error('Unexpected I/O');
    });
    vi.stubGlobal('fetch', fetch);
    vi.mocked(readFile).mockClear();
    vi.mocked(writeFile).mockClear();
    const selected = model('google-vertex');
    for (const suffix of [
      '',
      '?download=other.txt#fake.png',
      '#fake.txt?file.png',
    ]) {
      const attachmentUrl = `https://media.example/folder.txt/my.file.${extension}${suffix}`;
      expect(
        await prepareRemoteInput(selected, capabilities, {
          url: attachmentUrl,
        }),
      ).toEqual({
        type: 'content',
        value: [
          {
            type: 'file',
            mediaType,
            data: { type: 'url', url: attachmentUrl },
          },
        ],
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each([
    'application/pdf',
    'IMAGE/JPEG',
    '',
    'image/*',
    'invalid',
    'video/mp4',
  ])(
    'honors explicit type %s over the extension, including rejection',
    async (mediaType) => {
      const result = await prepareRemoteInput(model('openai'), capabilities, {
        url: 'https://media.example/photo.png',
        mediaType,
      });
      if (['application/pdf', 'IMAGE/JPEG'].includes(mediaType)) {
        expect(result).toMatchObject({
          type: 'content',
          value: [{ mediaType: mediaType.toLowerCase() }],
        });
      } else {
        expect(result).toEqual(remoteInputUnavailable());
      }
    },
  );

  it.each([
    '/',
    '/file',
    '/file.unknown',
    '/file.txt',
    '/file.json',
    '/file.svg',
    '/folder.png/file',
    '/folder.png/',
    '/.png',
    '/file.',
    '/file.png.exe',
    '/file%2Epng',
    '/file.p%6Eg',
    '/file.png;download',
    '/file?name=image.png',
    '/file#image.png',
    '/file.png/..',
  ])(
    'does not guess a type for path %s even with wildcard provider support',
    async (path) => {
      expect(
        await prepareRemoteInput(model('google-vertex'), capabilities, {
          url: `https://media.example${path}`,
        }),
      ).toEqual(remoteInputUnavailable());
    },
  );

  it('applies capability, subtype, provider, and model URL gates to inferred types', async () => {
    const image = { url: 'https://media.example/photo.png' };
    const video = { url: 'https://media.example/clip.mp4' };
    expect(await prepareRemoteInput(model('openai'), {}, image)).toEqual(
      remoteInputUnavailable(),
    );
    expect(
      await prepareRemoteInput(
        model('openai'),
        { image: { mediaTypes: ['image/jpeg'] } },
        image,
      ),
    ).toEqual(remoteInputUnavailable());
    expect(
      await prepareRemoteInput(model('openai'), capabilities, video),
    ).toEqual(remoteInputUnavailable());
    expect(
      await prepareRemoteInput(
        model('google-gemini', 'gemini-2.0-flash'),
        capabilities,
        video,
      ),
    ).toEqual(remoteInputUnavailable());
    expect(
      await prepareRemoteInput(
        model('google-vertex'),
        {},
        { url: 'https://media.example/clip.mp3' },
      ),
    ).toEqual(remoteInputUnavailable());
    expect(
      await prepareRemoteInput(model('openai'), capabilities, {
        url: 'file:///photo.png',
      }),
    ).toEqual(remoteInputUnavailable());
    expect(
      await prepareRemoteInput(model('openai'), capabilities, {
        url: 'https://user:secret@media.example/photo.png',
      }),
    ).toEqual(remoteInputUnavailable());
  });

  it.each(builtInProviderDefinitions.map(({ type }) => type))(
    '%s uses its declared remote URL capabilities',
    async (type) => {
      const fetch = vi.fn(() => {
        throw new Error('Unexpected I/O');
      });
      vi.stubGlobal('fetch', fetch);
      vi.mocked(readFile).mockClear();
      const accepted = [
        'openai',
        'azure-openai',
        'responses',
        'chatgpt-codex-subscription',
        'anthropic',
        'anthropic-messages',
        'google-gemini',
        'google-generative',
        'google-vertex',
      ].includes(type);
      const result = await prepareRemoteInput(model(type), capabilities, {
        url,
        mediaType: 'image/png',
      });
      expect(result.type).toBe(accepted ? 'content' : 'error-text');
      expect(fetch).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    },
  );

  it.each(['application/pdf', 'video/mp4', 'text/plain', 'application/json'])(
    'accepts declared %s without restricting media to images',
    async (mediaType) => {
      expect(
        (
          await prepareRemoteInput(
            model('google-gemini'),
            {},
            { url, mediaType },
          )
        ).type,
      ).toBe('content');
    },
  );

  it('accepts remote audio on Vertex but rejects it when no remote audio capability is declared', async () => {
    expect(
      (
        await prepareRemoteInput(model('google-vertex'), capabilities, {
          url,
          mediaType: 'audio/wav',
        })
      ).type,
    ).toBe('content');
    expect(
      await prepareRemoteInput(model('google-gemini'), capabilities, {
        url,
        mediaType: 'audio/wav',
      }),
    ).toEqual(remoteInputUnavailable());
    expect(
      await prepareRemoteInput(
        model('google-vertex'),
        {},
        { url, mediaType: 'audio/wav' },
      ),
    ).toEqual(remoteInputUnavailable());
  });

  it('respects selected model URL restrictions and media subtype gates', async () => {
    expect(
      await prepareRemoteInput(
        model('google-gemini', 'gemini-2.0-flash'),
        capabilities,
        { url, mediaType: 'video/mp4' },
      ),
    ).toEqual(remoteInputUnavailable());
    expect(
      await prepareRemoteInput(
        model('anthropic'),
        { image: { mediaTypes: ['image/jpeg'] } },
        { url, mediaType: 'image/png' },
      ),
    ).toEqual(remoteInputUnavailable());
    expect(
      await prepareRemoteInput(model('openai'), capabilities, {
        url,
        mediaType: 'video/mp4',
      }),
    ).toEqual(remoteInputUnavailable());
  });

  it.each([
    { url },
    { url: `${url}.pdf` },
    { url, mediaType: 'image/*' },
    { url, mediaType: 'application/pdf; charset=utf-8' },
    { url: 'file:///private', mediaType: 'application/pdf' },
    { url: 'data:application/pdf;base64,secret', mediaType: 'application/pdf' },
    { url: 'https:media.example', mediaType: 'application/pdf' },
    {
      url: 'https://user:secret@media.example/file',
      mediaType: 'application/pdf',
    },
    { url: 'https://media.example/\nsecret', mediaType: 'application/pdf' },
  ])(
    'returns the same sanitized error for invalid/unknown input $url',
    async (input) => {
      expect(
        await prepareRemoteInput(model('openai'), capabilities, input),
      ).toEqual(remoteInputUnavailable());
    },
  );
});

describe.each([false, true])(
  'native remote content and subsequent generation failures (streaming=%s)',
  (streaming) => {
    it.each([
      ['openai', 'application/pdf', 'responses'],
      ['azure-openai', 'application/pdf', 'responses'],
      ['responses', 'image/png', 'responses'],
      ['chatgpt-codex-subscription', 'image/png', 'responses'],
      ['anthropic', 'application/pdf', 'anthropic'],
      ['anthropic-messages', 'image/png', 'anthropic'],
      ['google-gemini', 'video/mp4', 'google'],
      ['google-generative', 'application/pdf', 'google'],
      ['google-vertex', 'audio/wav', 'google'],
    ] as const)(
      '%s maps %s to exact native content without downloading',
      async (type, mediaType, family) => {
        const requests: {
          url: string;
          body: {
            input: { type: string; output: unknown }[];
            messages: { content: { content: unknown }[] }[];
            contents: { parts: { fileData?: unknown }[] }[];
          };
        }[] = [];
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input, init) => {
            requests.push({ url: String(input), body: JSON.parse(init.body) });
            return new Response(
              JSON.stringify({
                error: {
                  message: `Rejected ${url}`,
                  type: 'invalid_request_error',
                },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            );
          }),
        );
        const selected = model(type);
        const output = await prepareRemoteInput(selected, capabilities, {
          url,
          mediaType,
        });
        expect(output.type).toBe('content');
        expect(requests).toHaveLength(0);
        const options = {
          model: selected,
          maxRetries: 0,
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call',
                  toolName: 'readAttachment',
                  input: {},
                },
              ],
            },
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'call',
                  toolName: 'readAttachment',
                  output: remoteInputModelOutput(output),
                },
              ],
            },
          ] satisfies ModelMessage[],
        };
        let streamError: unknown;
        const failure = streaming
          ? await Promise.resolve(
              streamText({
                ...options,
                onError: ({ error }) => {
                  streamError = error;
                },
              }).text,
            ).catch((error: unknown) => streamError ?? error)
          : await generateText(options).catch((error: unknown) => error);
        expect(classifyGenerationError(failure).reason).toBe(
          'bad request (400)',
        );
        expect(requests).toHaveLength(1);
        const request = requests[0];
        assert(request);
        expect(request.url).not.toContain('media.example');
        const body = request.body;
        if (family === 'responses') {
          expect(
            body.input.find((item) => item.type === 'function_call_output')
              ?.output,
          ).toEqual([
            mediaType.startsWith('image/')
              ? { type: 'input_image', image_url: url }
              : { type: 'input_file', file_url: url },
          ]);
        } else if (family === 'anthropic') {
          expect(body.messages[1]?.content[0]?.content).toEqual([
            {
              type: mediaType.startsWith('image/') ? 'image' : 'document',
              source: { type: 'url', url },
            },
          ]);
        } else {
          expect(
            body.contents
              .flatMap((item) => item.parts)
              .filter((item) => item.fileData),
          ).toEqual([{ fileData: { mimeType: mediaType, fileUri: url } }]);
          expect(JSON.stringify(body)).not.toContain('inlineData');
        }
      },
    );

    it.each([429, 503])(
      'leaves HTTP %s handling to the existing generation classifier',
      async (status) => {
        vi.stubGlobal(
          'fetch',
          vi.fn(
            async () =>
              new Response(JSON.stringify({ error: { message: url } }), {
                status,
              }),
          ),
        );
        const failure = await generateText({
          model: model('openai'),
          prompt: 'Continue',
          maxRetries: 0,
        }).catch((error: unknown) => error);
        expect(classifyGenerationError(failure)).toMatchObject({
          isModelError: true,
          reason: `server error (${status})`,
        });
      },
    );

    it('keeps transport details out of generation classifications', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError(`fetch failed ${url}`);
        }),
      );
      const failure = await generateText({
        model: model('openai'),
        prompt: 'Continue',
        maxRetries: 0,
      }).catch((error: unknown) => error);
      expect(JSON.stringify(classifyGenerationError(failure))).not.toContain(
        url,
      );
    });
  },
);

import { readFile, writeFile } from 'node:fs/promises';

import type {
  JSONSchema7,
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
} from '@ai-sdk/provider';
import { generateText, jsonSchema, type ModelMessage, streamText } from 'ai';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ProviderType } from '@/config';
import { testLogger } from '@/session/chat/test-helpers';
import { ToolExecutor } from '@/session/interaction/tool-executor';
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
  assert(definition?.createLanguageModel);
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

describe('Google recursive JSON input declarations (KLEX-89)', () => {
  // Mirrors Slack's apiBodyFields + parameters record + identity fields.
  // Separate z.json() instances preserve Slack's two recursive definitions.
  const inputSchema = z.toJSONSchema(
    z.strictObject({
      method: z.string().max(200),
      httpMethod: z.enum(['GET', 'POST']).default('POST'),
      body: z.json().optional(),
      'content-type': z.string().max(256).optional(),
      bodyEncoding: z.enum(['utf8', 'base64']).optional(),
      parameters: z.record(z.string(), z.json()).optional(),
      identityId: z.uuid(),
      workspaceId: z.string().min(1).optional(),
    }),
  ) as JSONSchema7;
  const ordinarySchema: JSONSchema7 = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  };
  const args = {
    identityId: '12345678-1234-4234-8234-123456789abc',
    method: 'chat.postMessage',
    httpMethod: 'POST',
    body: { values: [null, false, 42, 'hello', [], { nested: true }] },
    parameters: {
      channel: 'C123',
      text: 'hello',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*hello*' } }],
      metadata: {
        event_payload: { nested: [null, false, 42, { values: [] }] },
      },
    },
  };

  it('generates distinct self-recursive JSON definitions for body and parameters', () => {
    expect(inputSchema.properties?.body).toEqual({
      $ref: '#/$defs/__schema0',
    });
    expect(inputSchema.properties?.parameters).toEqual({
      type: 'object',
      propertyNames: { type: 'string' },
      additionalProperties: { $ref: '#/$defs/__schema1' },
    });
    const defs = inputSchema.$defs as Record<string, unknown>;
    expect(Object.keys(defs)).toEqual(['__schema0', '__schema1']);
    for (const name of ['__schema0', '__schema1']) {
      expect(defs[name]).toEqual({
        anyOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'null' },
          { type: 'array', items: { $ref: `#/$defs/${name}` } },
          {
            type: 'object',
            propertyNames: { type: 'string' },
            additionalProperties: { $ref: `#/$defs/${name}` },
          },
        ],
      });
    }
  });

  it.each([
    'google-gemini',
    'google-generative',
    'google-vertex',
    'langdock',
  ] as const)(
    '%s serializes safe declarations and dispatches native args in generate and stream',
    async (type) => {
      const before = structuredClone(inputSchema);
      const requests: {
        tools: {
          functionDeclarations: {
            name: string;
            parametersJsonSchema: JSONSchema7;
          }[];
        }[];
      }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, init) => {
          requests.push(JSON.parse(init.body));
          const response = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ functionCall: { name: 'useSlackApi', args } }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          };
          return String(url).includes('streamGenerateContent')
            ? new Response(`data: ${JSON.stringify(response)}\n\n`, {
                headers: { 'content-type': 'text/event-stream' },
              })
            : Response.json(response);
        }),
      );
      for (const streaming of [false, true]) {
        const execute = vi.fn(async (input) => ({ ok: true, input }));
        const tools = {
          useSlackApi: { inputSchema: jsonSchema(inputSchema) },
          ordinary: { inputSchema: jsonSchema(ordinarySchema) },
        };
        const options = {
          model: model(type),
          tools,
          prompt: 'Send a Slack message',
          maxRetries: 0,
        };
        const result = streaming
          ? streamText(options)
          : await generateText(options);
        const calls = await result.toolCalls;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.input).toEqual(args);
        const executor = new ToolExecutor({
          logger: testLogger,
          tools: { useSlackApi: { ...tools.useSlackApi, execute } },
          modelMessages: [],
          sessionId: 'test',
          validateInput: true,
        });
        const call = calls[0];
        assert(call);
        const dispatched = await executor.execute({
          executionId: call.toolCallId,
          name: call.toolName,
          input: JSON.parse(JSON.stringify(call.input)),
        });
        expect(dispatched.status).toBe('success');
        expect(execute.mock.calls[0]?.[0]).toEqual(args);
        // Required original fields are still checked by the execution layer.
        expect(
          (
            await executor.execute({
              executionId: 'invalid',
              name: call.toolName,
              input: {},
            })
          ).status,
        ).toBe('error');
        expect(execute).toHaveBeenCalledTimes(1);
      }
      expect(requests).toHaveLength(2);
      expect(inputSchema).toEqual(before);
      for (const request of requests) {
        const declarations = request.tools.flatMap(
          (tool) => tool.functionDeclarations,
        );
        expect(declarations.map((tool) => tool.name)).toEqual([
          'useSlackApi',
          'ordinary',
        ]);
        expect(declarations[1]?.parametersJsonSchema).toEqual(ordinarySchema);
        const sent = declarations[0]?.parametersJsonSchema;
        assert(sent);
        expect(sent.properties).toEqual(inputSchema.properties);
        expect(sent.required).toEqual(inputSchema.required);
        expect(sent.additionalProperties).toBe(false);
        const defs = sent.$defs as Record<string, { anyOf: unknown[] }>;
        expect(Object.keys(defs)).toEqual(['__schema0', '__schema1']);
        for (const name of ['__schema0', '__schema1']) {
          expect(defs[name]).toEqual({
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
              { type: 'array', items: {} },
              {
                type: 'object',
                propertyNames: { type: 'string' },
                additionalProperties: true,
              },
            ],
          });
        }
        // All remaining refs lead into a definition containing no further refs:
        // neither required nor optional reference cycles can survive on the wire.
        expect(JSON.stringify(defs)).not.toContain('"$ref"');
      }
    },
  );

  it('keeps Anthropic recursive declarations and native arguments unchanged', async () => {
    let request: { tools: { input_schema: unknown }[] } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        request = JSON.parse(init.body);
        return Response.json({
          id: 'message',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [
            { type: 'tool_use', id: 'call', name: 'useSlackApi', input: args },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }),
    );
    const result = await generateText({
      model: model('anthropic', 'claude-sonnet-4-5'),
      prompt: 'Send a Slack message',
      maxRetries: 0,
      tools: { useSlackApi: { inputSchema: jsonSchema(inputSchema) } },
    });
    expect(request?.tools[0]?.input_schema).toEqual(inputSchema);
    expect(result.toolCalls[0]?.input).toEqual(args);
  });
});

describe('Google JSON tool result references (KLEX-61)', () => {
  const ref = '#/$defs/__schema0';
  const schema = {
    $ref: ref,
    $defs: { __schema0: { type: 'string', description: 'A useful schema' } },
  };
  const outputs = [
    { type: 'json', value: schema },
    { type: 'json', value: { tools: [{ schema }] } },
    { type: 'json', value: [schema] },
    { type: 'error-json', value: { schema } },
    { type: 'json', value: { ok: true, items: [null, 1, 'text'] } },
    { type: 'json', value: { description: `$ref: ${ref}` } },
    { type: 'text', value: JSON.stringify(schema) },
    { type: 'error-text', value: 'Tool failed' },
    {
      type: 'content',
      value: [
        { type: 'text', text: JSON.stringify(schema) },
        {
          type: 'file',
          mediaType: 'image/png',
          data: { type: 'data', data: 'aGVsbG8=' },
        },
      ],
    },
  ] satisfies LanguageModelV4ToolResultOutput[];
  const prompt: LanguageModelV4Prompt = [
    {
      role: 'assistant',
      content: outputs.map((_, i) => ({
        type: 'tool-call',
        toolCallId: `call-${i}`,
        toolName: 'inspect',
        input: {},
      })),
    },
    {
      role: 'tool',
      content: outputs.map((output, i) => ({
        type: 'tool-result',
        toolCallId: `call-${i}`,
        toolName: 'inspect',
        output,
      })),
    },
  ];

  it.each([
    'google-gemini',
    'google-generative',
    'google-vertex',
    'langdock',
  ] as const)(
    '%s sends refs as lossless text for generation and streaming',
    async (type) => {
      const requests: {
        contents: {
          parts: { functionResponse?: { response: { content: unknown } } }[];
        }[];
      }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input, init) => {
          requests.push(JSON.parse(init.body));
          // Only request serialization is under test; no live Gemini call.
          return new Response(
            JSON.stringify({ error: { message: 'Test response' } }),
            {
              status: 400,
              headers: { 'content-type': 'application/json' },
            },
          );
        }),
      );
      const before = structuredClone(prompt);
      const selected = model(type);
      await expect(selected.doGenerate({ prompt })).rejects.toThrow();
      await expect(selected.doStream({ prompt })).rejects.toThrow();
      expect(prompt).toEqual(before);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        const parts = request.contents.flatMap((message) => message.parts);
        const responses = parts.flatMap((part) =>
          part.functionResponse ? [part.functionResponse.response.content] : [],
        );
        expect(responses).toHaveLength(outputs.length);
        for (const i of [0, 1, 2, 3]) {
          expect(typeof responses[i]).toBe('string');
          expect(responses[i]).toContain(ref);
          expect(JSON.parse(responses[i] as string)).toEqual(outputs[i]?.value);
        }
        for (const i of [4, 5, 6, 7]) {
          expect(responses[i]).toEqual(outputs[i]?.value);
        }
        expect(responses[8]).toBe(JSON.stringify(schema));
        expect(parts).toContainEqual({
          inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' },
        });
      }
    },
  );

  it('does not wrap any non-Google provider', () => {
    const selected = {} as LanguageModelV4;
    for (const { type } of builtInProviderDefinitions) {
      if (
        ['google-gemini', 'google-generative', 'google-vertex'].includes(type)
      )
        continue;
      expect(withRemoteInputMapping(selected, type)).toBe(selected);
    }
  });
});

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
    ['M4V', 'video/mp4'],
    ['AvI', 'video/avi'],
    ['FLV', 'video/x-flv'],
    ['WMV', 'video/wmv'],
    ['3GP', 'video/3gpp'],
    ['BMP', 'image/bmp'],
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

  it.each(
    builtInProviderDefinitions
      .filter((definition) => definition.createLanguageModel !== undefined)
      .map(({ type }) => type),
  )('%s uses its declared remote URL capabilities', async (type) => {
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
      'vercel-ai-gateway',
      'langdock',
    ].includes(type);
    const result = await prepareRemoteInput(model(type), capabilities, {
      url,
      mediaType: 'image/png',
    });
    expect(result.type).toBe(accepted ? 'content' : 'error-text');
    expect(fetch).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

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

describe('remote media type aliases and provider-declared types', () => {
  const https = /^https:\/\/.*$/;
  const stub = (types: string[]) =>
    ({
      specificationVersion: 'v4',
      provider: 'stub',
      modelId: 'stub',
      supportedUrls: Object.fromEntries(types.map((type) => [type, [https]])),
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    }) as unknown as LanguageModelV4;
  const mediaTypeOf = async (
    selected: LanguageModelV4,
    input: { url: string; mediaType?: string },
    caps: Parameters<typeof prepareRemoteInput>[1] = capabilities,
  ) => {
    const result = await prepareRemoteInput(selected, caps, input);
    return result.type === 'content' ? result.value[0].mediaType : undefined;
  };

  it('accepts an inferred .avi on Gemini as video/avi', async () => {
    expect(
      await mediaTypeOf(model('google-gemini'), {
        url: 'https://media.example/clip.avi',
      }),
    ).toBe('video/avi');
  });

  it.each([
    ['video/x-msvideo', 'video/avi'],
    ['VIDEO/MSVIDEO', 'video/avi'],
    ['video/x-ms-wmv', 'video/wmv'],
    ['image/jpg', 'image/jpeg'],
  ])('sends declared %s to Gemini as %s', async (declared, sent) => {
    expect(
      await mediaTypeOf(model('google-gemini'), { url, mediaType: declared }),
    ).toBe(sent);
  });

  it('prefers an exact provider match over the alias', async () => {
    expect(
      await mediaTypeOf(stub(['video/x-msvideo', 'video/avi']), {
        url,
        mediaType: 'video/x-msvideo',
      }),
    ).toBe('video/x-msvideo');
  });

  it('rejects an alias the provider declares under neither name', async () => {
    expect(
      await prepareRemoteInput(stub(['video/mp4']), capabilities, {
        url,
        mediaType: 'video/x-msvideo',
      }),
    ).toEqual(remoteInputUnavailable());
  });

  it('still rejects unknown extensions without a mediaType', async () => {
    expect(
      await prepareRemoteInput(stub(['*']), capabilities, {
        url: 'https://media.example/clip.mkv',
      }),
    ).toEqual(remoteInputUnavailable());
  });

  it('accepts a declared type outside the Klex table when the provider declares it', async () => {
    expect(
      await mediaTypeOf(stub(['video/x-matroska']), {
        url: 'https://media.example/clip.mkv',
        mediaType: 'video/x-matroska',
      }),
    ).toBe('video/x-matroska');
  });

  it('applies audio capability subtypes to the aliased type', async () => {
    const selected = stub(['audio/wav']);
    const input = { url, mediaType: 'audio/x-wav' };
    expect(
      await mediaTypeOf(selected, input, {
        audio: { mediaTypes: ['audio/wav'] },
      }),
    ).toBe('audio/wav');
    expect(
      await prepareRemoteInput(
        selected,
        { audio: { mediaTypes: ['audio/mpeg'] } },
        input,
      ),
    ).toEqual(remoteInputUnavailable());
  });

  it('keeps the URL unchanged and still requires a supportedUrls match', async () => {
    expect(
      await prepareRemoteInput(stub(['video/avi']), capabilities, {
        url,
        mediaType: 'video/x-msvideo',
      }),
    ).toEqual({
      type: 'content',
      value: [
        { type: 'file', mediaType: 'video/avi', data: { type: 'url', url } },
      ],
    });
    expect(
      await prepareRemoteInput(stub(['video/avi']), capabilities, {
        url: 'http://media.example/clip.avi',
      }),
    ).toEqual(remoteInputUnavailable());
  });
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
      ['langdock', 'application/pdf', 'google'],
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
        const classified = classifyGenerationError(failure);
        expect(classified.reason).toBe('request rejected (400)');
        expect(classified.isRequestRejected).toBe(true);
        expect(classified.isFatal).toBe(false);
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
              ? { type: 'input_image', image_url: url, detail: 'auto' }
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

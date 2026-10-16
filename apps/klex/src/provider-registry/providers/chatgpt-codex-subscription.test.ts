import '@/ai-sdk-warnings';

import { APICallError, generateText, Output, streamText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';

import { chatGptCodexSubscriptionProviderDefinition as provider } from './chatgpt-codex-subscription';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async () =>
    JSON.stringify({
      tokens: {
        access_token: 'synthetic-token',
        account_id: 'synthetic-account',
      },
    }),
  ),
}));

const classification = {
  q0: 0.99,
  q1: 0.01,
  q2: 'square',
};
const message = (text = JSON.stringify(classification)) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const completed = (output: unknown[] = [message()]) => ({
  id: 'resp_test',
  model: 'gpt-5.6-luna',
  created_at: 1,
  status: 'completed',
  output,
  usage: {
    input_tokens: 12,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});
const frame = (event: unknown, newline = '\n') =>
  `data: ${JSON.stringify(event)}${newline}${newline}`;
function sse(
  text: string,
  chunkSize = text.length,
  cancel = vi.fn(),
  contentType: string | null = 'text/event-stream',
) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset = Math.min(offset + chunkSize, bytes.length);
      },
      cancel,
    }),
    {
      headers: {
        ...(contentType !== null && { 'content-type': contentType }),
        'x-request-id': 'req_test',
        'content-length': String(bytes.length),
      },
    },
  );
}
function model() {
  if (!provider.createLanguageModel) throw new Error('Missing factory');
  return provider.createLanguageModel(
    {
      id: 'codex',
      type: provider.type,
      settings: { authFile: '/synthetic/auth.json' },
    },
    'gpt-5.6-luna',
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Codex subscription generation transport', () => {
  it.each([
    { chunkSize: 1, contentType: 'text/event-stream' },
    { chunkSize: 7, contentType: 'text/event-stream' },
    { chunkSize: 10000, contentType: 'text/event-stream' },
    { chunkSize: 1, contentType: null },
    { chunkSize: 7, contentType: null },
    { chunkSize: 10000, contentType: null },
  ])(
    'generates schema-valid output over $chunkSize-byte SSE chunks with Content-Type $contentType',
    async ({ chunkSize, contentType }) => {
      const fetchMock = vi.fn(async () =>
        sse(
          ': heartbeat\r\n\r\n' +
            'event: response.created\r\n' +
            frame(
              { type: 'response.created', response: { id: 'resp_test' } },
              '\r\n',
            ) +
            'event: response.completed\r\n' +
            frame(
              {
                type: 'response.completed',
                response: completed(),
              },
              '\r\n',
            ),
          chunkSize,
          vi.fn(),
          contentType,
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const selected = model();
      const result = await generateText({
        model: selected,
        prompt: 'Return the classification.',
        temperature: 0,
        maxRetries: 0,
        output: Output.object({
          schema: z.object({
            q0: z.number().min(0).max(1),
            q1: z.number().min(0).max(1),
            q2: z.enum(['square', 'circle', 'triangle']),
          }),
        }),
      });
      expect(result.output).toEqual(classification);
      expect(result.usage).toMatchObject({
        inputTokens: 12,
        outputTokens: 8,
        inputTokenDetails: { cacheReadTokens: 2 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [
        unknown,
        RequestInit,
      ];
      const request = JSON.parse(init.body as string);
      expect(request).toMatchObject({
        model: 'gpt-5.6-luna',
        stream: true,
        store: false,
        text: { format: { type: 'json_schema', strict: true } },
      });
      expect(request).not.toHaveProperty('temperature');
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer synthetic-token',
      );
    },
  );

  it('assembles only completed output items, in index order, when the terminal event omits output', async () => {
    const schema = z.object({ answer: z.string() });
    const output = message('{"answer":"café"}');
    const response = completed();
    const { output: _output, ...metadata } = response;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse(
          frame({
            type: 'response.output_text.delta',
            delta: 'not a completed item',
          }) +
            frame({
              type: 'response.output_item.done',
              output_index: 1,
              item: output,
            }) +
            frame({
              type: 'response.output_item.done',
              output_index: 0,
              item: { id: 'reasoning', type: 'reasoning', summary: [] },
            }) +
            frame({ type: 'response.completed', response: metadata }),
          1,
        ),
      ),
    );
    const result = await generateText({
      model: model(),
      prompt: 'Reply with JSON',
      maxRetries: 0,
      maxOutputTokens: 10,
      temperature: 0,
      topP: 1,
      presencePenalty: 0,
      frequencyPenalty: 0,
      output: Output.object({ schema }),
    });
    expect(result.output).toEqual({ answer: 'café' });
    expect(result.response.headers).toMatchObject({
      'x-request-id': 'req_test',
      'content-type': 'application/json',
    });
    expect(result.response.headers).not.toHaveProperty('content-length');
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    const request = JSON.parse(init?.body as string);
    for (const key of [
      'max_output_tokens',
      'temperature',
      'top_p',
      'presence_penalty',
      'frequency_penalty',
    ])
      expect(request).not.toHaveProperty(key);
  });

  it('preserves reasoning and function calls for ordinary non-streaming SDK consumers', async () => {
    const output = [
      {
        id: 'reasoning_test',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Synthetic reasoning' }],
      },
      {
        id: 'tool_test',
        type: 'function_call',
        call_id: 'call_test',
        name: 'lookup',
        arguments: '{"query":"test"}',
        status: 'completed',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse(frame({ type: 'response.completed', response: completed(output) })),
      ),
    );
    const result = await model().doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    });
    expect(result.finishReason.unified).toBe('tool-calls');
    expect(result.content).toMatchObject([
      { type: 'reasoning', text: 'Synthetic reasoning' },
      {
        type: 'tool-call',
        toolCallId: 'call_test',
        toolName: 'lookup',
        input: '{"query":"test"}',
      },
    ]);
  });

  it('accepts multiline SSE data and a terminal event at EOF', async () => {
    const event = JSON.stringify({
      type: 'response.completed',
      response: completed([message('OK')]),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse(
          `event: response.completed\nid: ignored\ndata: {\ndata: ${event.slice(1)}`,
          1,
        ),
      ),
    );
    expect(
      (await generateText({ model: model(), prompt: 'test', maxRetries: 0 }))
        .text,
    ).toBe('OK');
  });

  it('leaves SDK streaming calls streaming', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse(
          frame({
            type: 'response.created',
            response: { id: 'resp_test', model: 'gpt-5.6-luna', created_at: 1 },
          }) +
            frame({
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...message(), content: [] },
            }) +
            frame({
              type: 'response.output_text.delta',
              item_id: 'msg_test',
              output_index: 0,
              content_index: 0,
              delta: 'OK',
            }) +
            frame({
              type: 'response.output_item.done',
              output_index: 0,
              item: message('OK'),
            }) +
            frame({
              type: 'response.completed',
              response: completed([message('OK')]),
            }),
          7,
        ),
      ),
    );
    const result = streamText({
      model: model(),
      prompt: 'Reply OK',
      maxRetries: 0,
    });
    expect(await result.text).toBe('OK');
    expect((await result.usage).inputTokens).toBe(12);
  });

  it('preserves HTTP failures rather than trying to collect an error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: 'Synthetic forbidden',
                type: 'invalid_request_error',
              },
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    await expect(
      generateText({ model: model(), prompt: 'test', maxRetries: 0 }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it.each(['response.failed', 'error'])(
    'preserves %s stream errors for SDK error handling',
    async (type) => {
      const error = {
        message: 'Synthetic stream rejection',
        type: 'invalid_request_error',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          sse(
            frame(
              type === 'error'
                ? { type, error }
                : {
                    type,
                    response: { ...completed([]), status: 'failed', error },
                  },
            ),
          ),
        ),
      );
      await expect(
        generateText({ model: model(), prompt: 'test', maxRetries: 0 }),
      ).rejects.toBeInstanceOf(APICallError);
    },
  );

  it('does not turn an unterminated stream of partial deltas into success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse(
          frame({
            type: 'response.output_text.delta',
            delta: JSON.stringify(classification),
          }),
        ),
      ),
    );
    await expect(
      generateText({ model: model(), prompt: 'test', maxRetries: 0 }),
    ).rejects.toThrow('ended before completion');
  });

  it('preserves incomplete-response usage without claiming a complete classification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse(
          frame({
            type: 'response.incomplete',
            response: {
              ...completed([message('{"answer":')]),
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
            },
          }),
        ),
      ),
    );
    await expect(
      generateText({
        model: model(),
        prompt: 'test',
        maxRetries: 0,
        output: Output.object({ schema: z.object({ answer: z.string() }) }),
      }),
    ).rejects.toMatchObject({
      finishReason: 'length',
      usage: { inputTokens: 12, outputTokens: 8 },
    });
  });

  it('closes the upstream stream immediately after the terminal event', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    frame({
                      type: 'response.completed',
                      response: completed([message('OK')]),
                    }),
                  ),
                );
              },
              cancel,
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
    expect(
      (await generateText({ model: model(), prompt: 'test', maxRetries: 0 }))
        .text,
    ).toBe('OK');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('propagates cancellation during response collection', async () => {
    const controller = new AbortController();
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          upstream = stream;
        },
      });
      init?.signal?.addEventListener(
        'abort',
        () => upstream?.error(init.signal?.reason),
        { once: true },
      );
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const work = generateText({
      model: model(),
      prompt: 'test',
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    const rejection = expect(work).rejects.toThrow('synthetic abort');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(new Error('synthetic abort'));
    await rejection;
  });
});

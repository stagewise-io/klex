import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import {
  convertToModelMessages,
  experimental_evaluate as evaluate,
  generateText,
  jsonSchema,
  readUIMessageStream,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderInstance } from '../provider-registry';
import { openRouterProviderDefinition as provider } from './openrouter';

const instance: ProviderInstance = {
  id: 'router',
  type: 'openrouter',
  settings: { apiKey: 'synthetic', headers: { 'x-test': 'custom' } },
};
const signal = () => new AbortController().signal;
const models = ['perplexity/pplx-decider-v1.2', 'morph/reflex'] as const;
const {
  discoverModels,
  resolveModelMetadata,
  createLanguageModel,
  createEvaluationModel,
} = provider;
if (
  !discoverModels ||
  !resolveModelMetadata ||
  !createLanguageModel ||
  !createEvaluationModel
) {
  throw new Error('OpenRouter provider is missing required model operations');
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter reasoning replay', () => {
  const modelId = 'google/gemini-3.8-flash';
  const signature = {
    type: 'reasoning.encrypted',
    format: 'google-gemini-v1',
    id: 'call-1',
    data: 'encrypted-signature',
  };
  const toolCall = {
    id: 'call-1',
    type: 'function',
    function: { name: 'lookup', arguments: '{}' },
  };
  const tools = {
    lookup: tool({
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
      }),
    }),
  };
  const completion = (message: unknown) =>
    Response.json({
      id: 'response-1',
      model: modelId,
      choices: [{ message, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  const sse = (deltas: unknown[]) =>
    new Response(
      [
        ...deltas.map(
          (delta) =>
            `data: ${JSON.stringify({ id: 'response-1', model: modelId, choices: [{ delta, finish_reason: null }] })}\n\n`,
        ),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );

  it('replays generated tool metadata through model messages', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return completion({
          role: 'assistant',
          content: null,
          tool_calls: [toolCall],
          reasoning_details: [signature],
        });
      }),
    );
    const model = createLanguageModel(instance, modelId);
    const result = await generateText({
      model,
      prompt: 'lookup',
      tools,
      maxRetries: 0,
    });
    expect(
      result.toolCalls[0]?.providerMetadata?.openrouter?.reasoning_details,
    ).toEqual([signature]);
    expect(result.providerMetadata?.openrouter?.reasoning_details).toEqual([
      signature,
    ]);
    await generateText({
      model,
      messages: [
        ...result.response.messages,
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'lookup',
              output: { type: 'text', value: 'done' },
            },
          ],
        },
      ],
      tools,
      maxRetries: 0,
    });
    expect(bodies[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoning_details: [signature],
          tool_calls: [toolCall],
        }),
      ]),
    );
  });

  it.each(['before', 'same', 'after'] as const)(
    'persists signatures arriving %s tool arguments through the UI stream',
    async (timing) => {
      const bodies: Record<string, unknown>[] = [];
      const callDelta = { tool_calls: [{ ...toolCall, index: 0 }] };
      const reasoningDelta = { reasoning_details: [signature] };
      const deltas =
        timing === 'same'
          ? [{ ...callDelta, ...reasoningDelta }]
          : timing === 'before'
            ? [reasoningDelta, callDelta]
            : [callDelta, reasoningDelta];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)));
          return bodies.length === 1
            ? sse(deltas)
            : completion({ role: 'assistant', content: 'done' });
        }),
      );
      const model = createLanguageModel(instance, modelId);
      const result = streamText({
        model,
        prompt: 'lookup',
        tools,
        maxRetries: 0,
      });
      let message: UIMessage | undefined;
      for await (const update of readUIMessageStream({
        stream: result.toUIMessageStream(),
        terminateOnError: true,
      }))
        message = update;
      expect(message).toBeDefined();
      const part = message?.parts.find((part) => part.type === 'tool-lookup');
      expect(part).toMatchObject({
        callProviderMetadata: {
          openrouter: { reasoning_details: [signature] },
        },
      });
      if (!message) throw new Error('Missing UI message');
      for (const part of message.parts) {
        if (part.type === 'tool-lookup')
          Object.assign(part, { state: 'output-available', output: 'done' });
      }
      const messages = await convertToModelMessages([message]);
      await generateText({ model, messages, tools, maxRetries: 0 });
      expect(bodies[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            reasoning_details: [signature],
          }),
        ]),
      );
      expect(
        (await result.providerMetadata)?.openrouter?.reasoning_details,
      ).toEqual([signature]);
    },
  );

  it.each([
    modelId,
    'anthropic/claude-haiku-5.5',
    'minimax/minimax-m3.1-flash',
  ])('handles unsigned and foreign history for %s', async (target) => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return completion({ content: 'done' });
      }),
    );
    const foreign = {
      type: 'reasoning.encrypted',
      format: 'anthropic-claude-v1',
      data: 'foreign',
    };
    const prompt: LanguageModelV4Prompt = [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'old thinking',
            providerOptions: { openrouter: { reasoning_details: [foreign] } },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: {},
          },
          {
            type: 'tool-call',
            toolCallId: 'call-2',
            toolName: 'lookup',
            input: {},
          },
        ],
      },
    ];
    await createLanguageModel(instance, target).doGenerate({ prompt });
    const assistant = (body.messages as Record<string, unknown>[])[0];
    if (!assistant) throw new Error('Missing assistant message');
    if (target === modelId) {
      expect(assistant.reasoning_details).toEqual(
        ['call-1', 'call-2'].map((id) => ({
          ...signature,
          id,
          data: 'skip_thought_signature_validator',
        })),
      );
      expect(assistant.tool_calls).toEqual(
        ['call-1', 'call-2'].map((id) =>
          expect.objectContaining({
            id,
            extra_content: {
              google: { thought_signature: 'skip_thought_signature_validator' },
            },
          }),
        ),
      );
      expect(assistant).not.toHaveProperty('reasoning_content');
      expect(assistant).not.toHaveProperty('reasoning');
    } else {
      expect(assistant.reasoning_details).toEqual([foreign]);
      expect(JSON.stringify(assistant)).not.toContain(
        'skip_thought_signature_validator',
      );
    }
  });

  it.each([{}, { id: null }])(
    'does not treat id-less encrypted metadata %j as a tool-call signature',
    async (identity) => {
      let body: Record<string, unknown> = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init: RequestInit) => {
          body = JSON.parse(String(init.body));
          return completion({ content: 'done' });
        }),
      );
      const entry = {
        type: 'reasoning.encrypted',
        format: 'google-gemini-v1',
        data: 'unassociated-encrypted-metadata',
        ...identity,
      };
      await createLanguageModel(instance, modelId).doGenerate({
        prompt: [
          {
            role: 'assistant',
            providerOptions: { openrouter: { reasoning_details: [entry] } },
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'lookup',
                input: {},
              },
            ],
          },
        ],
      });
      expect(body.messages).toEqual([
        expect.objectContaining({
          reasoning_details: [
            entry,
            { ...signature, data: 'skip_thought_signature_validator' },
          ],
          tool_calls: [
            {
              ...toolCall,
              extra_content: {
                google: {
                  thought_signature: 'skip_thought_signature_validator',
                },
              },
            },
          ],
        }),
      ]);
    },
  );

  it('deduplicates message and part metadata, filters unsigned text, and keeps existing signatures', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return completion({ content: 'done' });
      }),
    );
    const entries = [
      signature,
      { type: 'reasoning.text', format: 'google-gemini-v1', text: 'unsigned' },
      {
        type: 'reasoning.text',
        format: 'anthropic-claude-v1',
        text: 'unsigned',
      },
    ];
    await createLanguageModel(instance, modelId).doGenerate({
      prompt: [
        {
          role: 'assistant',
          providerOptions: { openrouter: { reasoning_details: entries } },
          content: [
            {
              type: 'reasoning',
              text: 'thinking',
              providerOptions: { openrouter: { reasoning_details: entries } },
            },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'lookup',
              input: {},
              providerOptions: { openrouter: { reasoning_details: entries } },
            },
            {
              type: 'tool-call',
              toolCallId: 'call-2',
              toolName: 'lookup',
              input: {},
              providerOptions: { google: { thoughtSignature: 'existing' } },
            },
            {
              type: 'tool-call',
              toolCallId: 'call-3',
              toolName: 'lookup',
              input: {},
            },
          ],
        },
      ],
    });
    expect(body.messages).toEqual([
      expect.objectContaining({
        reasoning_details: [
          signature,
          {
            ...signature,
            id: 'call-3',
            data: 'skip_thought_signature_validator',
          },
        ],
        tool_calls: [
          expect.objectContaining({ id: 'call-1' }),
          expect.objectContaining({
            id: 'call-2',
            extra_content: { google: { thought_signature: 'existing' } },
          }),
          expect.objectContaining({
            id: 'call-3',
            extra_content: {
              google: { thought_signature: 'skip_thought_signature_validator' },
            },
          }),
        ],
      }),
    ]);
  });

  it('preserves generated reasoning-only details and existing part metadata', async () => {
    const entries = [
      { type: 'reasoning.summary', summary: 'thinking' },
      signature,
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        completion({
          content: 'answer',
          reasoning_details: entries,
          tool_calls: [
            {
              ...toolCall,
              extra_content: { google: { thought_signature: 'existing' } },
            },
          ],
        }),
      ),
    );
    const result = await createLanguageModel(instance, modelId).doGenerate({
      prompt: [],
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          text: 'thinking',
          providerMetadata: { openrouter: { reasoning_details: entries } },
        }),
        expect.objectContaining({
          type: 'text',
          providerMetadata: { openrouter: { reasoning_details: entries } },
        }),
        expect.objectContaining({
          type: 'tool-call',
          providerMetadata: {
            openrouter: {
              thoughtSignature: 'existing',
              reasoning_details: entries,
            },
          },
        }),
      ]),
    );
  });

  it('accumulates reasoning text and summaries and preserves end metadata', async () => {
    const fragments = [
      {
        type: 'reasoning.text',
        text: 'Think ',
        format: 'test',
        index: 0,
        signature: 'signed',
      },
      { type: 'reasoning.text', text: 'more', format: 'test', index: 0 },
      { type: 'reasoning.summary', summary: 'Summary ', index: 1 },
      { type: 'reasoning.summary', summary: 'done', index: 1 },
      signature,
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          ...fragments.map((entry) => ({ reasoning_details: [entry] })),
          { content: 'answer' },
        ]),
      ),
    );
    const result = await createLanguageModel(instance, modelId).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    const parts = [];
    for await (const part of result.stream) parts.push(part);
    const expected = [
      { ...fragments[0], text: 'Think more' },
      { ...fragments[2], summary: 'Summary done' },
      signature,
    ];
    expect(
      parts
        .filter((part) => part.type === 'reasoning-delta')
        .map((part) => part.delta)
        .join(''),
    ).toBe('Think moreSummary done');
    for (const part of parts)
      if (
        part.type === 'reasoning-end' ||
        part.type === 'text-end' ||
        part.type === 'finish'
      )
        expect(part.providerMetadata?.openrouter?.reasoning_details).toEqual(
          expected,
        );
  });
});

describe('OpenRouter decision models', () => {
  it('discovers the separate decisions catalog and deduplicates models', async () => {
    const decisionModels = [...models, 'future/decision'].map((id) => ({
      id,
      name: id,
      context_length: 65_536,
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['decisions'],
      },
      supported_parameters: [],
      endpoints: ['/api/alpha/decisions'],
    }));
    const fetchMock = vi.fn(async (url: URL) =>
      Response.json({
        data: url.searchParams.has('output_modalities')
          ? [
              ...decisionModels,
              {
                id: 'cloudflare/clairic',
                architecture: { output_modalities: ['decisions'] },
                endpoints: ['/api/alpha/extractions'],
              },
            ]
          : [
              {
                id: 'vendor/chat',
                architecture: { output_modalities: ['text'] },
              },
              decisionModels[0],
            ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const abortSignal = signal();
    const result = await discoverModels(instance, abortSignal);
    expect(result).toMatchObject({
      ok: true,
      value: [
        { modelId: 'vendor/chat', kind: 'language' },
        ...decisionModels.map(({ id }) => ({
          modelId: id,
          kind: 'evaluation',
          contextSize: 65_536,
          capabilities: { input: { image: {} } },
        })),
      ],
    });
    expect(result.ok && result.value).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const options = (call as unknown as [URL, RequestInit])[1];
      expect(options.signal).toBe(abortSignal);
      expect(options.headers).toMatchObject({
        Authorization: 'Bearer synthetic',
        'X-Title': 'Klex',
      });
    }
  });

  it.each([false, true])(
    'preserves discovery when the decisions catalog fails: %s',
    async (failDecisions) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: URL) => {
          const decisions = url.searchParams.has('output_modalities');
          return decisions === failDecisions
            ? new Response('unavailable', { status: 503 })
            : Response.json({
                data: [
                  {
                    id: decisions ? 'future/decision' : 'vendor/chat',
                    architecture: {
                      output_modalities: [decisions ? 'decisions' : 'text'],
                    },
                  },
                ],
              });
        }),
      );
      expect(await discoverModels(instance, signal())).toMatchObject({
        ok: true,
        partial: true,
        value: [
          {
            modelId: failDecisions ? 'vendor/chat' : 'future/decision',
            kind: failDecisions ? 'language' : 'evaluation',
          },
        ],
      });
    },
  );

  it.each([401, 429, 503])(
    'preserves HTTP %s when both catalogs fail',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status })),
      );
      expect(await discoverModels(instance, signal())).toMatchObject({
        ok: false,
        code: 'discovery_failed',
        message: `Provider returned HTTP ${status}`,
      });
    },
  );

  it('treats malformed catalogs as failures rather than complete empty lists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: null })),
    );
    expect(await discoverModels(instance, signal())).toMatchObject({
      ok: false,
      code: 'discovery_failed',
    });
  });

  it('does not publish a partial catalog after cancellation', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.searchParams.has('output_modalities')) {
          controller.abort();
          throw controller.signal.reason;
        }
        return Response.json({ data: [{ id: 'vendor/chat' }] });
      }),
    );
    expect(await discoverModels(instance, controller.signal)).toMatchObject({
      ok: false,
      code: 'discovery_failed',
    });
  });

  it.each(models)('keeps %s evaluation-only before discovery', (modelId) => {
    expect(resolveModelMetadata(modelId)).toMatchObject({
      kind: 'evaluation',
    });
    expect(() => createLanguageModel(instance, modelId)).toThrow(
      'Evaluation-only',
    );
  });

  it.each(models)(
    'evaluates boolean, choice and score questions with %s',
    async (modelId) => {
      const fetchMock = vi.fn(async () =>
        Response.json({
          id: 'synthetic-response',
          model: modelId,
          provider: 'Synthetic',
          answers: {
            flag: { type: 'noul', noul: 0.8 },
            route: {
              type: 'choice',
              choice: 'a',
              probabilities: { a: 0.9, b: 0.1 },
              confidence: 0.7,
            },
            urgency: {
              type: 'score',
              score: 0.75,
              probabilities: { '0': 0.25, '1': 0.75 },
            },
          },
          usage: { input_tokens: 20, output_tokens: 3, cost: 0.001 },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const abortSignal = signal();
      const result = await evaluate({
        model: createEvaluationModel(instance, modelId),
        state: { ticket: 'Synthetic ticket' },
        questions: {
          flag: {
            type: 'boolean',
            instructions: 'Flag?',
            criteria: { true: 'yes', false: 'no' },
          },
          route: {
            type: 'choice',
            instructions: 'Route?',
            criteria: { a: 'A', b: 'B' },
          },
          urgency: {
            type: 'score',
            instructions: 'Urgency?',
            criteria: ['low', 'high'],
          },
        },
        providerOptions: {
          openrouter: {
            provider: { order: ['Synthetic'] },
            model: 'must-not-override',
          },
        },
        abortSignal,
        maxRetries: 0,
      });
      expect(result.answers.flag).toEqual({
        type: 'boolean',
        probability: 0.8,
      });
      expect(result.answers.route).toMatchObject({
        type: 'choice',
        choice: 'a',
      });
      expect(result.answers.urgency).toMatchObject({
        type: 'score',
        score: 0.75,
      });
      expect(result.usage.totalTokens).toBe(23);
      expect(result.providerMetadata?.openrouter).toMatchObject({
        cost: 0.001,
        confidence: { route: 0.7 },
      });
      const [url, options] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
      expect(options.signal).toBe(abortSignal);
      expect(new Headers(options.headers).get('authorization')).toBe(
        'Bearer synthetic',
      );
      expect(new Headers(options.headers).get('x-title')).toBe('Klex');
      expect(new Headers(options.headers).get('x-test')).toBe('custom');
      expect(JSON.parse(options.body as string)).toMatchObject({
        model: modelId,
        state: { ticket: 'Synthetic ticket' },
        questions: {
          flag: { type: 'noul', criteria: { true: 'yes', false: 'no' } },
        },
        provider: { order: ['Synthetic'] },
      });
    },
  );

  it('uses a configured proxy prefix and propagates HTTP errors', async () => {
    const fetchMock = vi.fn(
      async () => new Response('private upstream error', { status: 429 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      createEvaluationModel(
        {
          ...instance,
          settings: {
            ...instance.settings,
            baseUrl: 'https://synthetic.invalid/proxy/api/v1/',
          },
        },
        models[0],
      ).doEvaluate({
        state: 'test',
        questions: { flag: { type: 'boolean', instructions: 'Flag?' } },
      }),
    ).rejects.toMatchObject({ statusCode: 429, isRetryable: true });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://synthetic.invalid/proxy/api/alpha/decisions',
    );
  });

  it.each([
    { flag: { type: 'refusal', reason: 'No answer' } },
    { flag: { type: 'noul', noul: 1.5 } },
  ])(
    'rejects unsupported or invalid answers instead of inventing decisions',
    async (answers) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            model: models[0],
            answers,
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
        ),
      );
      await expect(
        evaluate({
          model: createEvaluationModel(instance, models[0]),
          state: 'test',
          questions: { flag: { type: 'boolean', instructions: 'Flag?' } },
          maxRetries: 0,
        }),
      ).rejects.toThrow();
    },
  );
});

import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { builtInProviderDefinitions } from './providers';
import { withPromptCaching } from './prompt-caching';

afterEach(() => vi.unstubAllGlobals());

const prompt: LanguageModelV4CallOptions['prompt'] = [
  { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
];

describe.each(['doGenerate', 'doStream'] as const)(
  '%s prompt caching',
  (method) => {
    it.each(['anthropic', 'anthropic-messages'] as const)(
      'preserves %s message cache breakpoints without a top-level default',
      async (type) => {
        const fetch = vi.fn(
          async (_url: unknown, _init?: RequestInit) =>
            new Response(
              JSON.stringify({ error: { message: 'Captured request' } }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            ),
        );
        vi.stubGlobal('fetch', fetch);
        const model = builtInProviderDefinitions.find(
          (provider) => provider.type === type,
        )!.createLanguageModel!(
          { id: type, type, settings: { apiKey: 'synthetic' } },
          'claude-sonnet-4-5',
        );
        await expect(
          model[method]({
            prompt: [
              {
                role: 'system',
                content: 'Cached instructions',
                providerOptions: {
                  anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
                },
              },
              ...prompt,
            ],
          }),
        ).rejects.toThrow();
        const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
        expect(body).not.toHaveProperty('cache_control');
        expect(body.system[0].cache_control).toEqual({
          type: 'ephemeral',
          ttl: '1h',
        });
      },
    );
    it.each([
      'anthropic',
      'anthropic-messages',
      'openrouter',
      'vercel-ai-gateway',
    ] as const)(
      'sends defaults, custom settings, and opt-outs through the %s SDK',
      async (type) => {
        const gateway = type === 'vercel-ai-gateway';
        const namespace = gateway
          ? 'gateway'
          : type === 'openrouter'
            ? 'openrouter'
            : 'anthropic';
        const key = gateway
          ? 'caching'
          : type === 'openrouter'
            ? 'cache_control'
            : 'cacheControl';
        const factory = builtInProviderDefinitions.find(
          (provider) => provider.type === type,
        )!.createLanguageModel!;
        const model = factory(
          { id: type, type, settings: { apiKey: 'synthetic' } },
          gateway ? 'openai/gpt-4.1' : 'claude-sonnet-4-5',
        );
        for (const setting of [
          'absent',
          'custom',
          'undefined',
          'null',
        ] as const) {
          const custom = gateway ? 'auto' : { type: 'ephemeral', ttl: '1h' };
          const options = {
            ...(gateway ? { models: ['anthropic/claude-sonnet-4.5'] } : {}),
            ...(setting === 'absent'
              ? {}
              : {
                  [key]:
                    setting === 'custom'
                      ? custom
                      : setting === 'null'
                        ? null
                        : undefined,
                }),
          };
          const fetch = vi.fn(
            async (_url: unknown, _init?: RequestInit) =>
              new Response(
                JSON.stringify({ error: { message: 'Captured request' } }),
                {
                  status: 400,
                  headers: { 'content-type': 'application/json' },
                },
              ),
          );
          vi.stubGlobal('fetch', fetch);
          await expect(
            model[method]({
              prompt,
              providerOptions: { [namespace]: options },
            }),
          ).rejects.toThrow();
          expect(fetch).toHaveBeenCalledTimes(1);
          const init = fetch.mock.calls[0]![1]!;
          const body = JSON.parse(init.body as string);
          const enabled = setting === 'absent' || setting === 'custom';
          if (gateway) {
            expect(
              new Headers(init.headers).get('x-vercel-ai-gateway-caching'),
            ).toBe(enabled ? 'auto' : null);
            expect(body.providerOptions.gateway).toEqual({
              models: ['anthropic/claude-sonnet-4.5'],
              ...(enabled ? { caching: 'auto' } : {}),
            });
          } else {
            expect(body.cache_control).toEqual(
              enabled
                ? setting === 'custom'
                  ? custom
                  : { type: 'ephemeral' }
                : undefined,
            );
            if (!enabled) expect(body).not.toHaveProperty('cache_control');
          }
          expect(options).toEqual({
            ...(gateway ? { models: ['anthropic/claude-sonnet-4.5'] } : {}),
            ...(setting === 'absent'
              ? {}
              : {
                  [key]:
                    setting === 'custom'
                      ? custom
                      : setting === 'null'
                        ? null
                        : undefined,
                }),
          });
        }
      },
    );

    it.each([
      ['anthropic', 'anthropic-messages'],
      ['openrouter', 'openaiCompatible'],
    ] as const)(
      'respects all %s cache aliases and prompt locations',
      async (namespace, alias) => {
        for (const name of [namespace, alias]) {
          for (const key of ['cacheControl', 'cache_control']) {
            for (const value of [
              undefined,
              null,
              { type: 'ephemeral', ttl: '1h' },
            ]) {
              for (const location of ['call', 'message', 'part']) {
                const native = new MockLanguageModelV4();
                const model = withPromptCaching(native, namespace, [alias]);
                const providerOptions = {
                  [name]: { [key]: value, unrelated: true },
                };
                const options: LanguageModelV4CallOptions = {
                  prompt: [
                    {
                      role: 'user',
                      content: [
                        {
                          type: 'text',
                          text: 'Hello',
                          ...(location === 'part' && { providerOptions }),
                        },
                      ],
                      ...(location === 'message' && { providerOptions }),
                    },
                  ],
                  providerOptions:
                    location === 'call'
                      ? providerOptions
                      : { other: { keep: true } },
                };
                await expect(model[method](options)).rejects.toThrow(
                  'Not implemented',
                );
                const forwarded =
                  method === 'doGenerate'
                    ? native.doGenerateCalls[0]!
                    : native.doStreamCalls[0]!;
                expect(forwarded).toEqual(
                  location === 'call' && value == null
                    ? {
                        ...options,
                        providerOptions: { [name]: { unrelated: true } },
                      }
                    : options,
                );
                expect(providerOptions[name]).toHaveProperty(key, value);
              }
            }
          }
        }
      },
    );
  },
);

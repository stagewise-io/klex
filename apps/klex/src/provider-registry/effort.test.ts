import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it } from 'vitest';

import {
  ollamaEffortCapability,
  openRouterEffortCapability,
  resolveEffort,
  reviewedEffortCapability,
} from './effort';

const identity = {
  providerId: 'primary',
  providerType: 'openai',
  modelId: 'o3',
};
const resolve = (intent: 'low' | 'medium' | 'high' | 'off' | 'exceptional') =>
  resolveEffort({
    identity,
    intent,
    capability: reviewedEffortCapability(identity),
  });

describe('effort resolution', () => {
  it.each(['low', 'medium', 'high'] as const)(
    'resolves verified %s without altering unrelated options',
    (intent) => {
      expect(resolve(intent)).toMatchObject({
        requested: intent,
        effective: intent,
        reasoning: intent,
        status: 'exact',
      });
    },
  );
  it('does not invent off or exceptional support', () => {
    expect(resolve('off')).toMatchObject({
      status: 'unsupported',
      reason: 'mandatory-thinking',
    });
    expect(resolve('exceptional')).toMatchObject({ status: 'unsupported' });
  });
  it('unknown deployments and new generations retain defaults', () => {
    for (const id of [
      { ...identity, modelId: 'o3-latest' },
      { ...identity, providerType: 'azure-openai' },
    ]) {
      expect(
        resolveEffort({
          identity: id,
          intent: 'low',
          capability: reviewedEffortCapability(id),
        }),
      ).toMatchObject({ status: 'unknown' });
    }
  });
  it('preserves fixed fields in any namespace without mutating the caller', () => {
    const options = { openai: { reasoningEffort: 'high', unrelated: true } };
    const result = resolveEffort({
      identity,
      intent: 'low',
      capability: reviewedEffortCapability(identity),
      providerOptions: options,
    });
    expect(result.status).toBe('fixed');
    expect(result.providerOptions).toEqual(options);
    expect(result.providerOptions).not.toBe(options);
  });
  it('validates discovered ranges and does not silently demote intent', () => {
    expect(
      openRouterEffortCapability({
        mandatory: false,
        supported_efforts: ['evil'],
      }),
    ).toBeUndefined();
    expect(
      openRouterEffortCapability({
        mandatory: true,
        supported_efforts: ['none', 'low'],
      }),
    ).toBeUndefined();
    expect(
      openRouterEffortCapability({
        mandatory: false,
        supported_efforts: ['high'],
        default_effort: 'low',
      }),
    ).toBeUndefined();
    const capability = openRouterEffortCapability({
      mandatory: true,
      supported_efforts: ['low', 'high'],
    });
    expect(capability).toBeDefined();
    if (!capability) throw new Error('fixture');
    expect(
      resolveEffort({ identity, intent: 'medium', capability }),
    ).toMatchObject({
      status: 'approximate',
      effective: 'high',
      providerOptions: { openrouter: { reasoning: { effort: 'high' } } },
    });
  });
  it('parses only bounded named Ollama controls with consistent defaults', () => {
    expect(
      ollamaEffortCapability({ values: [true, false], default: true }),
    ).toBeUndefined();
    expect(
      ollamaEffortCapability({ values: ['low', 'ultra'], default: 'low' }),
    ).toBeUndefined();
    expect(
      ollamaEffortCapability({ values: ['low'], default: 'high' }),
    ).toBeUndefined();
    const capability = ollamaEffortCapability({
      values: ['low', 'medium', 'high'],
      default: 'medium',
    });
    if (!capability) throw new Error('fixture');
    expect(
      resolveEffort({ identity, intent: 'low', capability }),
    ).toMatchObject({
      providerOptions: { ollama: { reasoningEffort: 'low' } },
      status: 'exact',
    });
  });

  it('requires budget headroom and explicit output bounds', () => {
    const capability = {
      kind: 'controlled',
      encoding: 'anthropic-budget',
      namespace: 'anthropic',
      mandatory: true,
      evidence: { source: 'operator', reference: 'test' },
      controls: [
        {
          kind: 'budget',
          minimum: 1024,
          maximum: 8192,
          outputHeadroom: 2048,
          budgets: { low: 1024, medium: 2048, high: 4096, exceptional: 8192 },
        },
      ],
    } as const;
    expect(resolveEffort({ identity, intent: 'high', capability }).status).toBe(
      'unsupported',
    );
    expect(
      resolveEffort({
        identity,
        intent: 'high',
        capability,
        maxOutputTokens: 6144,
      }),
    ).toMatchObject({
      effective: 4096,
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
      },
    });
  });
});

describe('installed SDK wire contracts (no live inference)', () => {
  it('encodes exact Claude adaptive thinking and effort', async () => {
    let body: Record<string, unknown> = {};
    const model = createAnthropic({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({
          id: 'fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    }).languageModel('claude-sonnet-4-6');
    const id = {
      ...identity,
      providerType: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    };
    const resolved = resolveEffort({
      identity: id,
      intent: 'low',
      capability: reviewedEffortCapability(id),
    });
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
      providerOptions: resolved.providerOptions,
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('encodes native OpenAI Responses effort', async () => {
    let body: Record<string, unknown> = {};
    const model = createOpenAI({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({
          id: 'fixture',
          created_at: 1,
          model: 'o3',
          output: [],
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    }).languageModel('o3');
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
      reasoning: resolve('low').reasoning,
    });
    expect(body.reasoning).toMatchObject({ effort: 'low' });
  });
  it('encodes OpenRouter reasoning object through the compatible transport', async () => {
    let body: Record<string, unknown> = {};
    const model = createOpenAICompatible({
      name: 'openrouter',
      baseURL: 'https://fixture.invalid',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({
          id: 'fixture',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        });
      },
    }).languageModel('fixture');
    const capability = openRouterEffortCapability({
      mandatory: false,
      supported_efforts: ['low', 'medium', 'high'],
    });
    if (!capability) throw new Error('fixture');
    const result = resolveEffort({
      identity,
      intent: 'low',
      capability,
      providerOptions: { openrouter: { unrelated: true } },
    });
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
      providerOptions: result.providerOptions,
    });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.unrelated).toBe(true);
  });
});

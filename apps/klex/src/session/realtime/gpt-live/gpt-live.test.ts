import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import type { PreparedInferenceContext } from '@/session/interaction';

import { createGPTLiveProtocolState } from './gpt-live';
import { buildGPTLiveSessionConfig } from './session-config';
import { GPTLiveWireEventError, parseLiveServerEvent } from './wire-events';

const delegation = {
  type: 'session.delegation.created',
  event_id: 'evt-delegation',
  offset_ms: 120,
  delegation: {
    id: 'delegation-1',
    type: 'delegation',
    target: 'responses',
    response_id: 'response-1',
  },
};

function responseEvent(event: Record<string, unknown>) {
  return {
    type: 'response.event',
    event_id: 'evt-response',
    delegation_id: 'delegation-1',
    event,
  };
}

describe('GPT-Live wire events', () => {
  it('parses lifecycle, transcript, audio, usage, and delegation events', () => {
    expect(
      parseLiveServerEvent({
        type: 'session.started',
        event_id: 'evt-start',
        session: { id: 'live-1' },
      }),
    ).toEqual({ type: 'session-started', sessionId: 'live-1' });
    expect(
      parseLiveServerEvent({
        type: 'session.input_transcript.delta',
        event_id: 'transcript-1',
        delta: 'hello ',
        start_ms: 10,
        end_ms: 20,
      }),
    ).toEqual({
      type: 'transcript-delta',
      speaker: 'user',
      eventId: 'transcript-1',
      delta: 'hello ',
      startMs: 10,
      endMs: 20,
    });
    expect(
      parseLiveServerEvent({
        type: 'session.output_audio.delta',
        delta: 'AAE=',
      }),
    ).toEqual({ type: 'output-audio-delta', delta: 'AAE=' });
    expect(
      parseLiveServerEvent({
        type: 'session.usage.updated',
        event_id: 'usage-1',
        usage: { seconds: 2.5 },
        context_window: { usage_ratio: 0.25 },
      }),
    ).toEqual({
      type: 'usage-updated',
      usageSeconds: 2.5,
      contextWindowRatio: 0.25,
    });
    expect(parseLiveServerEvent(delegation)).toEqual({
      type: 'delegation-created',
      delegationId: 'delegation-1',
      responseId: 'response-1',
      offsetMs: 120,
    });
  });

  it('parses completed function items and terminal Responses snapshots', () => {
    expect(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.created',
          sequence_number: 0,
          response: { id: 'response-actual' },
        }),
      ),
    ).toEqual({
      type: 'response-started',
      delegationId: 'delegation-1',
      responseId: 'response-actual',
    });
    expect(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.output_item.done',
          sequence_number: 2,
          output_index: 0,
          item: {
            id: 'item-1',
            type: 'function_call',
            call_id: 'call-1',
            name: 'lookup',
            arguments: '{"query":"x"}',
          },
        }),
      ),
    ).toEqual({
      type: 'response-function-call',
      delegationId: 'delegation-1',
      call: {
        itemId: 'item-1',
        callId: 'call-1',
        name: 'lookup',
        argumentsJson: '{"query":"x"}',
      },
    });
    expect(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call-without-arguments',
            name: 'lookup',
          },
        }),
      ),
    ).toMatchObject({
      type: 'response-function-call',
      call: { argumentsJson: '{}' },
    });
    expect(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'response-1',
            usage: { input_tokens: 12, output_tokens: 7 },
          },
        }),
      ),
    ).toEqual({
      type: 'response-terminal',
      delegationId: 'delegation-1',
      responseId: 'response-1',
      status: 'completed',
      inputTokens: 12,
      outputTokens: 7,
    });
  });

  it('ignores unknown outer, nested, and non-function output events', () => {
    expect(parseLiveServerEvent({ type: 'session.future' })).toEqual({
      type: 'ignored',
      name: 'session.future',
    });
    expect(
      parseLiveServerEvent(
        responseEvent({ type: 'response.future', value: 'preserved outside' }),
      ),
    ).toEqual({ type: 'ignored', name: 'response.event:response.future' });
    expect(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.output_item.done',
          item: { type: 'message' },
        }),
      ),
    ).toEqual({
      type: 'ignored',
      name: 'response.event:response.output_item.done',
    });
  });

  it('rejects malformed known events that affect correlation or media', () => {
    expect(() => parseLiveServerEvent('{')).toThrow(GPTLiveWireEventError);
    expect(() =>
      parseLiveServerEvent({
        type: 'session.output_audio.delta',
        delta: 4,
      }),
    ).toThrow('malformed delta');
    expect(() =>
      parseLiveServerEvent({
        type: 'session.output_audio.delta',
        delta: 'not base64',
      }),
    ).toThrow('malformed base64');
    expect(() =>
      parseLiveServerEvent({
        type: 'session.input_transcript.delta',
        event_id: 'oversized-transcript',
        delta: 'x'.repeat(32_001),
        start_ms: 0,
        end_ms: 1,
      }),
    ).toThrow('oversized delta');
    expect(() =>
      parseLiveServerEvent({
        type: 'session.input_transcript.delta',
        event_id: 'transcript-1',
        delta: 'invalid interval',
        start_ms: 20,
        end_ms: 10,
      }),
    ).toThrow('end_ms before start_ms');
    expect(() =>
      parseLiveServerEvent({
        ...delegation,
        delegation: { ...delegation.delegation, response_id: undefined },
      }),
    ).toThrow('delegation.response_id');
    expect(() =>
      parseLiveServerEvent({
        ...responseEvent({ type: 'response.completed', response: {} }),
        delegation_id: null,
      }),
    ).toThrow('delegation_id');
  });

  it('parses final closure and bounded provider errors', () => {
    expect(
      parseLiveServerEvent({
        type: 'session.closed',
        event_id: 'close-1',
        reason: 'close_requested',
        session: { id: 'live-1' },
        usage: { seconds: 11 },
      }),
    ).toEqual({
      type: 'session-closed',
      sessionId: 'live-1',
      reason: 'close_requested',
      usageSeconds: 11,
    });
    const parsed = parseLiveServerEvent({
      type: 'error',
      event_id: 'error-1',
      error: {
        type: 'invalid_request_error',
        code: 'bad_input',
        message: 'x'.repeat(2_000),
      },
    });
    expect(parsed).toMatchObject({
      type: 'provider-error',
      error: { code: 'bad_input' },
    });
    if (parsed.type !== 'provider-error') throw new Error('unexpected event');
    expect(parsed.error.message).toHaveLength(1_000);
  });
});

describe('GPT-Live startup configuration', () => {
  const context: PreparedInferenceContext = {
    instructions: 'backend business policy',
    messages: [
      { role: 'system', content: 'prior developer context' },
      { role: 'user', content: 'first question' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first answer' },
          {
            type: 'tool-call',
            toolCallId: 'lookup-1',
            toolName: 'lookup',
            input: { query: 'first' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'lookup-1',
            toolName: 'lookup',
            output: { type: 'json', value: { found: true } },
          },
        ],
      },
      { role: 'user', content: 'latest question' },
    ],
    tools: [
      {
        name: 'lookup',
        description: 'Looks up data',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ],
    model: {
      modelId: 'gpt-live-1',
      contextSize: 128_000,
      inputCapabilities: {},
    },
    historyRevision: 3,
    updateWatermark: 4,
  };

  it('separates frontend voice policy from backend instructions and tools', () => {
    const prepared = buildGPTLiveSessionConfig(context, {
      responsesModel: 'gpt-5.2',
      frontendInstructions: 'frontend voice policy',
      voice: 'alloy',
    });

    expect(prepared.session).toMatchObject({
      model: 'gpt-live-1',
      instructions: 'frontend voice policy',
      audio: {
        format: { type: 'audio/pcm', rate: 24_000 },
        output: { voice: 'alloy' },
      },
      delegation: {
        type: 'responses',
        responses: {
          model: 'gpt-5.2',
          instructions: 'backend business policy',
          tools: [
            {
              type: 'function',
              name: 'lookup',
              description: 'Looks up data',
              strict: false,
            },
          ],
        },
      },
    });
    expect(prepared.session.instructions).not.toContain('backend');
  });

  it('does not require optional tool parameters through strict mode', () => {
    const prepared = buildGPTLiveSessionConfig(
      {
        ...context,
        tools: [
          {
            name: 'getTime',
            inputSchema: {
              type: 'object',
              properties: {
                timezone: { type: ['string', 'null'], default: null },
              },
            },
          },
        ],
      },
      {
        responsesModel: 'gpt-5.2',
        frontendInstructions: 'voice policy',
      },
    );

    expect(prepared.session.delegation).toMatchObject({
      type: 'responses',
      responses: {
        tools: [
          {
            name: 'getTime',
            strict: false,
            parameters: {
              properties: { timezone: { default: null } },
            },
          },
        ],
      },
    });
  });

  it('projects only representable text history in canonical order', () => {
    const prepared = buildGPTLiveSessionConfig(context, {
      responsesModel: 'gpt-5.2',
      frontendInstructions: 'voice policy',
    });

    expect(prepared.session.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        status: 'completed',
        content: [{ type: 'input_text', text: 'prior developer context' }],
      },
      {
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'first question' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'first answer\n[Prior tool call lookup (lookup-1): {"query":"first"}]',
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [
          {
            type: 'input_text',
            text: '[Prior tool result lookup (lookup-1): {"type":"json","value":{"found":true}}]',
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'latest question' }],
      },
    ]);
  });

  it('retains the newest representable messages within explicit bounds', () => {
    const prepared = buildGPTLiveSessionConfig(context, {
      responsesModel: 'gpt-5.2',
      frontendInstructions: 'voice policy',
      maxHistoryMessages: 2,
    });

    expect(prepared.omittedHistoryMessages).toBe(3);
    expect(prepared.session.input?.map((item) => item.role)).toEqual([
      'user',
      'user',
    ]);
  });

  it('fails closed when the newest history message exceeds its budget', () => {
    expect(() =>
      buildGPTLiveSessionConfig(
        {
          ...context,
          messages: [{ role: 'user', content: 'newest message is too large' }],
        },
        {
          responsesModel: 'gpt-5.2',
          frontendInstructions: 'voice',
          maxHistoryTokens: 1,
        },
      ),
    ).toThrow('Newest GPT-Live history message');
  });

  it('fails closed when instruction budgets are exceeded', () => {
    expect(() =>
      buildGPTLiveSessionConfig(context, {
        responsesModel: 'gpt-5.2',
        frontendInstructions: 'too many words',
        maxFrontendInstructionTokens: 1,
      }),
    ).toThrow('frontend instructions');
    expect(() =>
      buildGPTLiveSessionConfig(
        {
          ...context,
          instructions: 'too many backend words',
        },
        {
          responsesModel: 'gpt-5.2',
          frontendInstructions: 'voice',
          maxBackendInstructionTokens: 1,
        },
      ),
    ).toThrow('backend instructions');
  });

  it('collects text while dropping unsupported history content', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'visible' },
          { type: 'file', data: 'ignored', mediaType: 'text/plain' },
        ],
      },
    ];
    const prepared = buildGPTLiveSessionConfig(
      { ...context, messages },
      {
        responsesModel: 'gpt-5.2',
        frontendInstructions: 'voice',
      },
    );
    expect(prepared.session.input?.[0]?.content).toEqual([
      { type: 'input_text', text: 'visible' },
    ]);
  });
});

describe('GPT-Live protocol state', () => {
  it('retains granular calls when a terminal snapshot has no output', () => {
    const state = createGPTLiveProtocolState();
    state.apply(parseLiveServerEvent(delegation));
    state.apply(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'lookup',
            arguments: '{}',
          },
        }),
      ),
    );
    state.apply(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.completed',
          response: { id: 'response-1', output: [] },
        }),
      ),
    );

    expect(state.response('response-1')).toEqual({
      delegationId: 'delegation-1',
      responseId: 'response-1',
      offsetMs: 120,
      status: 'completed',
      calls: [
        {
          callId: 'call-1',
          name: 'lookup',
          argumentsJson: '{}',
        },
      ],
    });
  });

  it('uses the nested Responses lifecycle ID as the authoritative ID', () => {
    const state = createGPTLiveProtocolState();
    state.apply(parseLiveServerEvent(delegation));
    state.apply(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.created',
          response: { id: 'response-actual' },
        }),
      ),
    );
    state.apply(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.completed',
          response: { id: 'response-actual' },
        }),
      ),
    );

    expect(state.response('response-1')).toBeUndefined();
    expect(state.response('response-actual')).toMatchObject({
      delegationId: 'delegation-1',
      responseId: 'response-actual',
      status: 'completed',
    });
  });

  it('deduplicates exact events and rejects changed opaque associations', () => {
    const state = createGPTLiveProtocolState();
    const parsedDelegation = parseLiveServerEvent(delegation);
    state.apply(parsedDelegation);
    state.apply(parsedDelegation);
    expect(() =>
      state.apply(
        parseLiveServerEvent({
          ...delegation,
          delegation: {
            ...delegation.delegation,
            response_id: 'response-other',
          },
        }),
      ),
    ).toThrow('changed response association');
    expect(() =>
      state.apply(
        parseLiveServerEvent(
          responseEvent({
            type: 'response.completed',
            response: { id: 'response-other' },
          }),
        ),
      ),
    ).toThrow('does not match delegation');
  });

  it('records failed response errors and terminal snapshots', () => {
    const errorState = createGPTLiveProtocolState();
    errorState.apply(parseLiveServerEvent(delegation));
    errorState.apply(
      parseLiveServerEvent(
        responseEvent({
          type: 'error',
          code: 'backend_error',
          message: 'failed',
        }),
      ),
    );
    expect(errorState.response('response-1')?.status).toBe('failed');

    const terminalState = createGPTLiveProtocolState();
    terminalState.apply(parseLiveServerEvent(delegation));
    terminalState.apply(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.failed',
          response: { id: 'response-1' },
        }),
      ),
    );
    expect(terminalState.response('response-1')?.status).toBe('failed');
  });

  it('keeps a terminal status when a conflicting later error arrives', () => {
    const state = createGPTLiveProtocolState();
    state.apply(parseLiveServerEvent(delegation));
    state.apply(
      parseLiveServerEvent(
        responseEvent({
          type: 'response.completed',
          response: { id: 'response-1' },
        }),
      ),
    );
    state.apply(
      parseLiveServerEvent(
        responseEvent({ type: 'error', code: 'late', message: 'late error' }),
      ),
    );
    expect(state.response('response-1')?.status).toBe('completed');
  });

  it('rejects unknown delegations and bounded-state overflow', () => {
    const state = createGPTLiveProtocolState({
      maxResponses: 1,
      maxCallsPerResponse: 1,
    });
    expect(() =>
      state.apply(
        parseLiveServerEvent(
          responseEvent({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'call-1',
              name: 'lookup',
              arguments: '{}',
            },
          }),
        ),
      ),
    ).toThrow('unknown delegation');
    state.apply(parseLiveServerEvent(delegation));
    expect(() =>
      state.apply(
        parseLiveServerEvent({
          ...delegation,
          delegation: {
            ...delegation.delegation,
            id: 'delegation-2',
            response_id: 'response-2',
          },
        }),
      ),
    ).toThrow('response state limit');
  });
});

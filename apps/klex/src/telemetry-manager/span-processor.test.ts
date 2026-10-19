import { SpanStatusCode } from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';

import { createTelemetrySpanProcessor } from './span-processor';

function makeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: 'test-span',
    kind: 0,
    spanContext: () => ({
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: 0,
      isRemote: false,
    }),
    parentSpanContext: undefined,
    startTime: [0, 0],
    endTime: [0, 0],
    status: { code: SpanStatusCode.OK },
    attributes: {
      'gen_ai.input.messages': 'secret-prompt',
      'gen_ai.output.messages': 'secret-response',
      'gen_ai.request.model': 'gpt-test',
      'klex.session.id': 'session-1',
      'klex.session.name': 'Primary session',
      'custom.attr': 'kept',
    },
    links: [],
    events: [],
    duration: [0, 0],
    ended: true,
    resource: {
      attributes: {},
      merge: vi.fn(),
      asyncMerge: vi.fn(),
    } as unknown as ReadableSpan['resource'],
    instrumentationScope: {
      name: 'test',
      version: '1.0.0',
    },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...overrides,
  };
}

function moveSpanContextToPrototype(span: ReadableSpan): ReadableSpan {
  const { spanContext, ...properties } = span;
  return Object.assign(
    Object.create({ spanContext }),
    properties,
  ) as ReadableSpan;
}

function makeDelegate(): {
  processor: SpanProcessor;
  onEnd: ReturnType<typeof vi.fn>;
  onStart: ReturnType<typeof vi.fn>;
} {
  const onEnd = vi.fn();
  const onStart = vi.fn();
  const processor = {
    onStart,
    onEnd,
    forceFlush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as SpanProcessor;
  return { processor, onEnd, onStart };
}

describe('TelemetrySpanProcessor', () => {
  it('drops all spans when level is "no"', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('no');

    tp.onEnd(makeSpan());
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('drops all spans when level is "basic"', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd, onStart } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('basic');

    tp.onStart({} as Span, undefined as never);
    tp.onEnd(makeSpan({ status: { code: SpanStatusCode.OK } }));
    tp.onEnd(makeSpan({ status: { code: SpanStatusCode.ERROR } }));

    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('applies the telemetry allowlist when level is "advanced"', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('advanced');

    tp.onEnd(makeSpan());

    expect(onEnd).toHaveBeenCalledTimes(1);
    const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    expect(forwarded.attributes['gen_ai.input.messages']).toBeUndefined();
    expect(forwarded.attributes['gen_ai.output.messages']).toBeUndefined();
    expect(forwarded.attributes['gen_ai.request.model']).toBe('gpt-test');
    expect(forwarded.attributes['klex.session.id']).toBe('session-1');
    expect(forwarded.attributes['klex.session.name']).toBe('Primary session');
    expect(forwarded.attributes['custom.attr']).toBeUndefined();
  });

  it('preserves the standard service instance resource attribute', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('advanced');

    tp.onEnd(
      makeSpan({
        resource: {
          attributes: {
            'service.name': 'klex',
            'service.instance.id': 'instance-1',
            'klex.instance.id': 'legacy-instance',
            'host.name': 'private-host',
          },
          merge: vi.fn(),
          asyncMerge: vi.fn(),
        } as unknown as ReadableSpan['resource'],
      }),
    );

    const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    expect(forwarded.resource.attributes).toEqual({
      'service.name': 'klex',
      'service.instance.id': 'instance-1',
    });
  });

  it('gates agent identity resource attributes by level', () => {
    const resource = {
      attributes: {
        'service.name': 'klex',
        'service.instance.id': 'instance-1',
        'klex.cloud.client_id': 'client-1',
        'klex.agent.name': 'Klex',
        'klex.agent.data_dir': '/Users/someone/.klex/agents/Klex',
        'host.name': 'private-host',
      },
      merge: vi.fn(),
      asyncMerge: vi.fn(),
    } as unknown as ReadableSpan['resource'];
    const exported = (level: 'basic' | 'advanced' | 'debug') => {
      const tp = createTelemetrySpanProcessor(level);
      const { processor, onEnd } = makeDelegate();
      tp.setDelegate(processor);
      tp.onEnd(makeSpan({ resource }));
      const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan | undefined;
      return forwarded?.resource.attributes;
    };

    // Nothing is exported at basic.
    expect(exported('basic')).toBeUndefined();
    expect(exported('advanced')).toEqual({
      'service.name': 'klex',
      'service.instance.id': 'instance-1',
      'klex.cloud.client_id': 'client-1',
      'klex.agent.name': 'Klex',
    });
    expect(exported('debug')).toEqual({
      'service.name': 'klex',
      'service.instance.id': 'instance-1',
      'klex.cloud.client_id': 'client-1',
      'klex.agent.name': 'Klex',
      'klex.agent.data_dir': '/Users/someone/.klex/agents/Klex',
    });
  });

  it('merges dynamic identity resource attributes at export time', () => {
    const tp = createTelemetrySpanProcessor('debug');
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    let clientId: string | null = null;
    tp.setDynamicResourceAttributes(() =>
      clientId ? { 'klex.cloud.client_id': clientId } : {},
    );

    tp.onEnd(makeSpan());
    clientId = 'client-1';
    tp.onEnd(makeSpan());

    const first = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    const second = onEnd.mock.calls[1]?.[0] as ReadableSpan;
    expect(first.resource.attributes['klex.cloud.client_id']).toBeUndefined();
    expect(second.resource.attributes['klex.cloud.client_id']).toBe('client-1');
  });

  it('does not drop spans when the dynamic resource supplier throws', () => {
    const tp = createTelemetrySpanProcessor('advanced');
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setDynamicResourceAttributes(() => {
      throw new Error('boom');
    });

    tp.onEnd(makeSpan());
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('preserves all non-attribute fields when scrubbing in "advanced" mode', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('advanced');

    const span = moveSpanContextToPrototype(
      makeSpan({
        name: 'custom-span',
        status: { code: SpanStatusCode.ERROR, message: 'failed' },
        duration: [1, 500_000_000],
        droppedAttributesCount: 3,
      }),
    );
    tp.onEnd(span);

    const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    expect(forwarded.name).toBe('custom-span');
    expect(forwarded.status).toEqual({
      code: SpanStatusCode.ERROR,
    });
    expect(forwarded.duration).toEqual([1, 500_000_000]);
    expect(forwarded.droppedAttributesCount).toBe(3);
    expect(forwarded.spanContext()).toEqual(span.spanContext());
    expect(forwarded.resource).toBe(span.resource);
    expect(forwarded.instrumentationScope).toBe(span.instrumentationScope);
    expect(forwarded.links).toBe(span.links);
    expect(forwarded.events).toBe(span.events);
  });

  it('preserves debug content while rejecting always-forbidden attributes', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('debug');

    const span = makeSpan({
      attributes: {
        'gen_ai.input.messages': 'debug prompt',
        authorization: 'Bearer secret',
      },
    });
    tp.onEnd(span);

    const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    expect(forwarded.attributes).toEqual({
      'gen_ai.input.messages': 'debug prompt',
    });
    expect(forwarded).not.toBe(span);
  });

  it('drops inline blob bytes from debug content but keeps their metadata', () => {
    const tp = createTelemetrySpanProcessor('debug');
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);

    const messages = [
      {
        role: 'user',
        parts: [
          { type: 'text', content: 'look' },
          {
            type: 'blob',
            modality: 'image',
            mime_type: 'image/png',
            content: 'AAAA',
          },
        ],
      },
    ];
    tp.onEnd(
      makeSpan({
        attributes: { 'gen_ai.input.messages': JSON.stringify(messages) },
      }),
    );

    const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    expect(
      JSON.parse(forwarded.attributes['gen_ai.input.messages'] as string),
    ).toEqual([
      {
        role: 'user',
        parts: [
          { type: 'text', content: 'look' },
          { type: 'blob', modality: 'image', mime_type: 'image/png' },
        ],
      },
    ]);
  });

  it('bounds oversized message content and keeps it valid JSON', () => {
    const tp = createTelemetrySpanProcessor('debug');
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);

    const big = 'x'.repeat(300 * 1024);
    const messages = [
      { role: 'user', parts: [{ type: 'text', content: big }] },
      { role: 'assistant', parts: [{ type: 'text', content: big }] },
      { role: 'user', parts: [{ type: 'text', content: 'latest' }] },
    ];
    tp.onEnd(
      makeSpan({
        attributes: { 'gen_ai.input.messages': JSON.stringify(messages) },
      }),
    );

    const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    const exported = forwarded.attributes['gen_ai.input.messages'] as string;
    expect(Buffer.byteLength(exported)).toBeLessThanOrEqual(512 * 1024);
    const parsed = JSON.parse(exported) as Array<{ role: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed.at(-1)).toEqual(messages[2]);
    expect(forwarded.attributes['klex.telemetry.input_messages_dropped']).toBe(
      1,
    );
  });

  it('truncates a single oversized part instead of dropping the last message', () => {
    const tp = createTelemetrySpanProcessor('debug');
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);

    const messages = [
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: 't1',
            response: 'y'.repeat(700 * 1024),
          },
        ],
      },
    ];
    tp.onEnd(
      makeSpan({
        attributes: { 'gen_ai.input.messages': JSON.stringify(messages) },
      }),
    );

    const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    const exported = forwarded.attributes['gen_ai.input.messages'] as string;
    expect(Buffer.byteLength(exported)).toBeLessThanOrEqual(512 * 1024);
    const parsed = JSON.parse(exported) as typeof messages;
    expect(parsed[0]?.parts[0]?.response.endsWith('…[truncated]')).toBe(true);
    expect(forwarded.attributes['klex.telemetry.content_truncated']).toBe(true);
  });

  it('preserves array-valued debug content without index-based truncation', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('debug');

    tp.onEnd(
      makeSpan({
        attributes: {
          'gen_ai.input.messages': ['first message', 'second message'],
        },
      }),
    );

    const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    expect(forwarded.attributes['gen_ai.input.messages']).toEqual([
      'first message',
      'second message',
    ]);
  });

  it('uses the current advanced level when debug is disabled before span end', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('advanced');

    const span = makeSpan({
      status: { code: SpanStatusCode.ERROR, message: 'secret status' },
      events: [
        {
          name: 'exception',
          time: [0, 0],
          attributes: {
            'exception.type': 'Error',
            'exception.message': 'secret exception',
          },
        },
        {
          name: 'secret-event',
          time: [0, 0],
          attributes: { 'custom.attr': 'secret event' },
        },
        {
          name: 'session-event',
          time: [0, 0],
          attributes: {
            'klex.session.id': 'session-1',
            'custom.attr': 'secret event',
          },
        },
      ],
      links: [
        {
          context: {
            traceId: '1'.repeat(32),
            spanId: '1'.repeat(16),
            traceFlags: 0,
            isRemote: false,
          },
          attributes: { 'custom.attr': 'secret link' },
        },
      ],
      resource: {
        attributes: {
          'service.name': 'klex',
          'service.instance.id': 'instance-1',
          'host.name': 'private-host',
        },
        merge: vi.fn(),
        asyncMerge: vi.fn(),
      } as unknown as ReadableSpan['resource'],
    });

    tp.onEnd(span);

    const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
    expect(forwarded).not.toBe(span);
    expect(forwarded.attributes).toEqual({
      'gen_ai.request.model': 'gpt-test',
      'klex.session.id': 'session-1',
      'klex.session.name': 'Primary session',
    });
    expect(forwarded.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(forwarded.events[0]?.attributes).toEqual({
      'exception.type': 'Error',
    });
    expect(forwarded.events[1]?.attributes).toEqual({});
    // Advanced span events use the advanced allowlist, not the basic one.
    expect(forwarded.events[2]?.attributes).toEqual({
      'klex.session.id': 'session-1',
    });
    expect(forwarded.links[0]?.attributes).toEqual({});
    expect(forwarded.resource.attributes).toEqual({
      'service.name': 'klex',
      'service.instance.id': 'instance-1',
    });
  });

  it('defaults to "no" level', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);

    tp.onEnd(makeSpan());
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('does not start spans when level is no', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onStart } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('no');

    const span = {} as Span;
    tp.onStart(span, undefined as never);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('does nothing on onEnd when no delegate is set', () => {
    const tp = createTelemetrySpanProcessor();
    tp.setLevel('debug');
    // Should not throw
    tp.onEnd(makeSpan());
  });

  it('forceFlush delegates to the wrapped processor', async () => {
    const tp = createTelemetrySpanProcessor();
    const { processor } = makeDelegate();
    tp.setDelegate(processor);

    await tp.forceFlush();
    expect(processor.forceFlush).toHaveBeenCalled();
  });

  it('shutdown delegates to the wrapped processor', async () => {
    const tp = createTelemetrySpanProcessor();
    const { processor } = makeDelegate();
    tp.setDelegate(processor);

    await tp.shutdown();
    expect(processor.shutdown).toHaveBeenCalled();
  });

  it('forceFlush resolves when no delegate is set', async () => {
    const tp = createTelemetrySpanProcessor();
    await expect(tp.forceFlush()).resolves.toBeUndefined();
  });

  it('shutdown resolves when no delegate is set', async () => {
    const tp = createTelemetrySpanProcessor();
    await expect(tp.shutdown()).resolves.toBeUndefined();
  });

  it('getLevel returns the current level', () => {
    const tp = createTelemetrySpanProcessor();
    expect(tp.getLevel()).toBe('no');
    tp.setLevel('no');
    expect(tp.getLevel()).toBe('no');
    tp.setLevel('basic');
    expect(tp.getLevel()).toBe('basic');
    tp.setLevel('advanced');
    expect(tp.getLevel()).toBe('advanced');
  });

  describe('GenAI JSON content', () => {
    const toolDefinitions = JSON.stringify([
      {
        type: 'function',
        name: 'read_file',
        description: 'x'.repeat(2_000),
        inputSchema: { type: 'object' },
      },
    ]);
    const inputMessages = JSON.stringify([
      {
        role: 'user',
        parts: [{ type: 'text', content: 'use token=abc"} and continue' }],
      },
    ]);
    const exportAt = (level: 'advanced' | 'debug') => {
      const tp = createTelemetrySpanProcessor(level);
      const { processor, onEnd } = makeDelegate();
      tp.setDelegate(processor);
      tp.onEnd(
        makeSpan({
          attributes: {
            'gen_ai.operation.name': 'generate_content',
            'gen_ai.input.messages': inputMessages,
            'gen_ai.tool.definitions': toolDefinitions,
            'agento11y.record': true,
          },
        }),
      );
      const exported = onEnd.mock.calls[0]?.[0] as ReadableSpan | undefined;
      if (exported === undefined) throw new Error('span was not exported');
      return exported.attributes;
    };

    it('excludes content and tool definitions at advanced but keeps the AO marker', () => {
      const attributes = exportAt('advanced');
      expect(attributes['gen_ai.input.messages']).toBeUndefined();
      expect(attributes['gen_ai.tool.definitions']).toBeUndefined();
      expect(attributes['agento11y.record']).toBe(true);
    });

    it('keeps tool definitions whole at debug', () => {
      const attributes = exportAt('debug');
      expect(attributes['gen_ai.tool.definitions']).toBe(toolDefinitions);
      expect(attributes['agento11y.record']).toBe(true);
    });

    it('redacts credentials per string leaf so the JSON stays valid', () => {
      const value = exportAt('debug')['gen_ai.input.messages'];
      expect(typeof value).toBe('string');
      const parsed: unknown = JSON.parse(value as string);
      expect(parsed).toEqual([
        {
          role: 'user',
          parts: [{ type: 'text', content: 'use [REDACTED] and continue' }],
        },
      ]);
    });

    it('falls back to string scrubbing for non-JSON values', () => {
      const tp = createTelemetrySpanProcessor('debug');
      const { processor, onEnd } = makeDelegate();
      tp.setDelegate(processor);
      tp.onEnd(
        makeSpan({
          attributes: { 'gen_ai.output.messages': 'not json password=hunter2' },
        }),
      );
      const forwarded = onEnd.mock.calls[0]?.[0] as ReadableSpan;
      expect(forwarded.attributes['gen_ai.output.messages']).toBe(
        'not json [REDACTED]',
      );
    });
  });
});

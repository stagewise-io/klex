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

  it('forwards all spans when level is "basic"', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('basic');

    tp.onEnd(makeSpan({ status: { code: SpanStatusCode.OK } }));
    tp.onEnd(makeSpan({ status: { code: SpanStatusCode.ERROR } }));

    expect(onEnd).toHaveBeenCalledTimes(2);
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
    tp.setContentAllowed(() => true);

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

  it('downgrades expired debug content permission to advanced privacy', () => {
    const tp = createTelemetrySpanProcessor();
    const { processor, onEnd } = makeDelegate();
    tp.setDelegate(processor);
    tp.setLevel('debug');
    tp.setContentAllowed(() => false);

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
});

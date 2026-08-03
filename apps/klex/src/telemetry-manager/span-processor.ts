import {
  type Attributes,
  type Context,
  SpanStatusCode,
} from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import type { TelemetryLevel } from '@/config';

/**
 * Attribute keys that carry user-facing content (prompts, model responses,
 * tool inputs/outputs). These are scrubbed in `reduced` mode to prevent
 * sensitive data from reaching the tracing backend.
 */
const SENSITIVE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.tool.definitions',
]);

function isErrorSpan(span: ReadableSpan): boolean {
  return span.status.code === SpanStatusCode.ERROR;
}

function scrubSpanAttributes(span: ReadableSpan): ReadableSpan {
  const scrubbed: Attributes = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    scrubbed[key] = SENSITIVE_ATTRIBUTE_KEYS.has(key) ? '[REDACTED]' : value;
  }
  return { ...span, attributes: scrubbed };
}

/**
 * A wrapping {@link SpanProcessor} that filters and scrubs spans based on
 * the current telemetry level. The delegate processor (typically a
 * `SimpleSpanProcessor` with an OTLP exporter) is set during tracing
 * initialization via {@link setDelegate}.
 *
 * - `off` — all spans are dropped.
 * - `minimum` — only error spans are forwarded.
 * - `reduced` — all spans are forwarded but sensitive attributes are
 *   replaced with `[REDACTED]`.
 * - `full` — all spans are forwarded unchanged.
 *
 * `onStart` is always delegated; filtering happens in `onEnd` where the
 * span status and attributes are known.
 */
export class TelemetrySpanProcessor implements SpanProcessor {
  private delegate: SpanProcessor | null = null;
  private level: TelemetryLevel = 'full';

  setDelegate(delegate: SpanProcessor): void {
    this.delegate = delegate;
  }

  setLevel(level: TelemetryLevel): void {
    this.level = level;
  }

  getLevel(): TelemetryLevel {
    return this.level;
  }

  onStart(span: Span, parentContext: Context): void {
    this.delegate?.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const delegate = this.delegate;
    if (!delegate) return;

    if (this.level === 'off') return;

    if (this.level === 'minimum' && !isErrorSpan(span)) return;

    if (this.level === 'reduced') {
      delegate.onEnd(scrubSpanAttributes(span));
      return;
    }

    delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate?.forceFlush() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.delegate?.shutdown() ?? Promise.resolve();
  }
}

export function createTelemetrySpanProcessor(): TelemetrySpanProcessor {
  return new TelemetrySpanProcessor();
}

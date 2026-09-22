import type { Attributes, Context, Link } from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
  TimedEvent,
} from '@opentelemetry/sdk-trace-base';

import type { RuntimeTelemetryLevel } from '@/config';
import {
  isAllowedTelemetryAttribute,
  isAlwaysForbiddenTelemetryAttribute,
  isTelemetryContentAttribute,
} from '@/telemetry-policy';

const MAX_SAFE_STRING_LENGTH = 512;
const SAFE_RESOURCE_ATTRIBUTES = new Set([
  'service.name',
  'service.namespace',
  'service.version',
  'deployment.environment',
  'service.instance.id',
  'process.runtime.name',
  'process.runtime.version',
]);
const SAFE_EXCEPTION_ATTRIBUTES = new Set(['exception.type']);

function sanitizeString(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(?:api[_-]?key|token|secret|password)[=:]\s*[^\s,;]+/gi,
      '[REDACTED]',
    )
    .replace(/(?:https?:\/\/|file:\/\/)[^\s]+/gi, '[URL_REDACTED]')
    .slice(0, MAX_SAFE_STRING_LENGTH);
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(sanitizeValue).slice(0, 32);
  return '[REDACTED]';
}

function safeResourceAttributes(attributes: Attributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SAFE_RESOURCE_ATTRIBUTES.has(key)) {
      result[key] = sanitizeValue(value) as Attributes[string];
    }
  }
  return result;
}

function safeAttributes(
  attributes: Attributes,
  level: RuntimeTelemetryLevel,
): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      isAllowedTelemetryAttribute(key, level) &&
      !isTelemetryContentAttribute(key)
    ) {
      result[key] = sanitizeValue(value) as Attributes[string];
    }
  }
  return result;
}

function safeDebugAttributes(attributes: Attributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isAlwaysForbiddenTelemetryAttribute(key)) {
      result[key] = sanitizeValue(value) as Attributes[string];
    }
  }
  return result;
}

function safeEvents(
  events: readonly TimedEvent[],
  debug = false,
): TimedEvent[] {
  return events.map((event) => {
    if (event.name === 'exception') {
      const attributes: Attributes = {};
      for (const [key, value] of Object.entries(event.attributes ?? {})) {
        if (SAFE_EXCEPTION_ATTRIBUTES.has(key)) {
          attributes[key] = sanitizeValue(value) as Attributes[string];
        }
      }
      return { ...event, attributes };
    }
    return {
      ...event,
      name: sanitizeString(event.name),
      attributes: event.attributes
        ? debug
          ? safeDebugAttributes(event.attributes)
          : safeAttributes(event.attributes, debug ? 'advanced' : 'basic')
        : undefined,
    };
  });
}

function safeLinks(
  links: readonly Link[],
  level: RuntimeTelemetryLevel,
): Link[] {
  return links.map((link) => ({
    ...link,
    attributes: link.attributes
      ? safeAttributes(link.attributes, level)
      : undefined,
  }));
}

function scrubSpan(
  span: ReadableSpan,
  level: RuntimeTelemetryLevel,
): ReadableSpan {
  const status = { ...span.status };
  if (level !== 'debug') delete status.message;
  const resourceAttributes = safeResourceAttributes(span.resource.attributes);
  const resource =
    Object.keys(resourceAttributes).length ===
      Object.keys(span.resource.attributes).length &&
    Object.entries(resourceAttributes).every(
      ([key, value]) => value === span.resource.attributes[key],
    )
      ? span.resource
      : { ...span.resource, attributes: resourceAttributes };
  return {
    ...span,
    // `spanContext` is a prototype method on SDK ReadableSpan objects, so it
    // is not preserved by object spread. Exporters call it during `onEnd()`.
    spanContext: span.spanContext.bind(span),
    name: sanitizeString(span.name),
    attributes:
      level === 'debug'
        ? safeDebugAttributes(span.attributes)
        : safeAttributes(span.attributes, level),
    status,
    events:
      span.events.length > 0
        ? safeEvents(span.events, level === 'debug')
        : span.events,
    links:
      level === 'debug'
        ? span.links.map((link) => ({
            ...link,
            attributes: link.attributes
              ? safeDebugAttributes(link.attributes)
              : undefined,
          }))
        : span.links.length > 0
          ? safeLinks(span.links, level)
          : span.links,
    resource,
  };
}

/**
 * Policy-enforcing span processor. Filtering happens at export time so spans
 * can still be useful internally while the exported ReadableSpan is rebuilt
 * from an explicit allowlist.
 */
export class TelemetrySpanProcessor implements SpanProcessor {
  private delegate: SpanProcessor | null = null;
  private level: RuntimeTelemetryLevel;
  constructor(initialLevel: RuntimeTelemetryLevel = 'no') {
    this.level = initialLevel;
  }
  private contentAllowed: () => boolean = () => true;

  setContentAllowed(contentAllowed: () => boolean): void {
    this.contentAllowed = contentAllowed;
  }

  setDelegate(delegate: SpanProcessor | null): void {
    this.delegate = delegate;
  }

  setLevel(level: RuntimeTelemetryLevel): void {
    this.level = level;
  }

  getLevel(): RuntimeTelemetryLevel {
    return this.level;
  }

  onStart(span: Span, parentContext: Context): void {
    if (this.level !== 'no') this.delegate?.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const delegate = this.delegate;
    if (!delegate || this.level === 'no') return;
    const level =
      this.level === 'debug' && !this.contentAllowed()
        ? 'advanced'
        : this.level;
    delegate.onEnd(scrubSpan(span, level));
  }

  forceFlush(): Promise<void> {
    return this.delegate?.forceFlush() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.delegate?.shutdown() ?? Promise.resolve();
  }
}

export function createTelemetrySpanProcessor(
  initialLevel: RuntimeTelemetryLevel = 'no',
): TelemetrySpanProcessor {
  return new TelemetrySpanProcessor(initialLevel);
}

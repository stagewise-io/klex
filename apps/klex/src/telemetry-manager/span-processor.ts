import type { Attributes, Context, Link } from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
  TimedEvent,
} from '@opentelemetry/sdk-trace-base';

import {
  isAllowedTelemetryAttribute,
  isAlwaysForbiddenTelemetryAttribute,
  isTelemetryContentAttribute,
  type RuntimeTelemetryLevel,
} from '@/telemetry-policy';

const MAX_SAFE_STRING_LENGTH = 512;
const MAX_DEBUG_CONTENT_STRING_LENGTH = 1_000_000;
const SAFE_RESOURCE_ATTRIBUTES = new Set([
  'host.arch',
  'os.type',
  'os.version',
  'service.name',
  'service.namespace',
  'service.version',
  'deployment.environment',
  'service.instance.id',
  'process.runtime.name',
  'process.runtime.version',
]);
/**
 * Identifying agent resource attributes and the lowest level that exports
 * them. Mirrors `createIdentityResourceAttributes`.
 */
const AGENT_RESOURCE_ATTRIBUTE_LEVELS = new Map<string, RuntimeTelemetryLevel>([
  ['klex.cloud.client_id', 'basic'],
  ['klex.agent.name', 'advanced'],
  ['klex.agent.data_dir', 'debug'],
]);
const LEVEL_RANK: Record<RuntimeTelemetryLevel, number> = {
  no: 0,
  basic: 1,
  advanced: 2,
  debug: 3,
};
const MAX_RESOURCE_PATH_LENGTH = 4_096;
const SAFE_EXCEPTION_ATTRIBUTES = new Set(['exception.type']);

/** Supplies resource attributes that can change at runtime (e.g. enrollment). */
export type DynamicResourceAttributes = () => Attributes;

function scrubCredentials(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(?:api[_-]?key|token|secret|password)[=:]\s*[^\s,;&]+/gi,
      '[REDACTED]',
    )
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** `advanced`: credentials and every URL are removed. */
function sanitizeString(
  value: string,
  maxLength = MAX_SAFE_STRING_LENGTH,
): string {
  return scrubCredentials(value)
    .replace(/(?:https?:\/\/|file:\/\/)[^\s]+/gi, '[URL_REDACTED]')
    .slice(0, maxLength);
}

/** `debug`: credentials are removed; URLs and paths are kept. */
function sanitizeDebugString(value: string, maxLength: number): string {
  return scrubCredentials(value).slice(0, maxLength);
}

function sanitizeValue(
  value: unknown,
  maxStringLength = MAX_SAFE_STRING_LENGTH,
): unknown {
  if (typeof value === 'string') return sanitizeString(value, maxStringLength);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeValue(entry, maxStringLength))
      .slice(0, 32);
  }
  return '[REDACTED]';
}

function isAgentResourceAttributeAllowed(
  key: string,
  level: RuntimeTelemetryLevel,
): boolean {
  const minimum = AGENT_RESOURCE_ATTRIBUTE_LEVELS.get(key);
  return minimum !== undefined && LEVEL_RANK[level] >= LEVEL_RANK[minimum];
}

function safeResourceAttributes(
  attributes: Attributes,
  level: RuntimeTelemetryLevel,
): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SAFE_RESOURCE_ATTRIBUTES.has(key)) {
      result[key] = sanitizeValue(value) as Attributes[string];
    } else if (isAgentResourceAttributeAllowed(key, level)) {
      result[key] = sanitizeValue(
        value,
        MAX_RESOURCE_PATH_LENGTH,
      ) as Attributes[string];
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
    if (isAllowedTelemetryAttribute(key, level, value)) {
      result[key] = sanitizeValue(value) as Attributes[string];
    }
  }
  return result;
}

function sanitizeDebugValue(
  value: unknown,
  maxStringLength: number,
  depth = 0,
): unknown {
  if (depth > 8) return '[MAX_DEPTH]';
  if (typeof value === 'string') {
    return sanitizeDebugString(value, maxStringLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((entry) => sanitizeDebugValue(entry, maxStringLength, depth + 1));
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .slice(0, 128)
          .map(([key, entry]) => [
            key,
            isAlwaysForbiddenTelemetryAttribute(key)
              ? '[REDACTED]'
              : sanitizeDebugValue(entry, maxStringLength, depth + 1),
          ]),
      ),
    );
  }
  return String(value);
}

function safeDebugAttributes(attributes: Attributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isAlwaysForbiddenTelemetryAttribute(key)) {
      result[key] = sanitizeDebugValue(
        value,
        isTelemetryContentAttribute(key)
          ? MAX_DEBUG_CONTENT_STRING_LENGTH
          : MAX_SAFE_STRING_LENGTH,
      ) as Attributes[string];
    }
  }
  return result;
}

function safeEvents(
  events: readonly TimedEvent[],
  level: RuntimeTelemetryLevel,
): TimedEvent[] {
  const debug = level === 'debug';
  return events.map((event) => {
    if (event.name === 'exception') {
      if (debug) {
        return {
          ...event,
          attributes: event.attributes
            ? safeDebugAttributes(event.attributes)
            : undefined,
        };
      }
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
          : safeAttributes(event.attributes, level)
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
      ? level === 'debug'
        ? safeDebugAttributes(link.attributes)
        : safeAttributes(link.attributes, level)
      : undefined,
  }));
}

function scrubSpan(
  span: ReadableSpan,
  level: RuntimeTelemetryLevel,
  dynamicResourceAttributes: Attributes,
): ReadableSpan {
  const status = { ...span.status };
  if (level !== 'debug') delete status.message;
  const resourceAttributes = {
    ...safeResourceAttributes(span.resource.attributes, level),
    ...dynamicResourceAttributes,
  };
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
      span.events.length > 0 ? safeEvents(span.events, level) : span.events,
    links: span.links.length > 0 ? safeLinks(span.links, level) : span.links,
    resource,
  };
}

function exportsTraces(level: RuntimeTelemetryLevel): boolean {
  return level === 'advanced' || level === 'debug';
}

/**
 * Policy-enforcing span processor. Spans are exported only at `advanced` and
 * `debug`. Filtering happens at export time so spans can still be useful
 * internally while the exported ReadableSpan is rebuilt from an explicit
 * allowlist.
 */
export class TelemetrySpanProcessor implements SpanProcessor {
  private delegate: SpanProcessor | null = null;
  private level: RuntimeTelemetryLevel;
  private dynamicResourceAttributes: DynamicResourceAttributes | null = null;
  constructor(initialLevel: RuntimeTelemetryLevel = 'no') {
    this.level = initialLevel;
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

  /**
   * Registers trusted resource attributes evaluated at export time. The
   * supplier owns level gating; its result bypasses the resource allowlist.
   */
  setDynamicResourceAttributes(
    supplier: DynamicResourceAttributes | null,
  ): void {
    this.dynamicResourceAttributes = supplier;
  }

  onStart(span: Span, parentContext: Context): void {
    if (exportsTraces(this.level)) this.delegate?.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const delegate = this.delegate;
    if (!delegate || !exportsTraces(this.level)) return;
    let dynamic: Attributes = {};
    try {
      dynamic = this.dynamicResourceAttributes?.() ?? {};
    } catch {
      // Telemetry is fail-open: a broken supplier must not drop the span.
    }
    delegate.onEnd(scrubSpan(span, this.level, dynamic));
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

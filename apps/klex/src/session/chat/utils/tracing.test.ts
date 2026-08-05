import { type Context, context } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { startChildSpan } from '@/tracing';

import { getExtensionIdentifier, withExtensionIdentifier } from './tracing';

describe('tracing — extensionIdentifier context', () => {
  it('returns undefined when no extension identifier is set', () => {
    expect(getExtensionIdentifier()).toBeUndefined();
  });

  it('round-trips an identifier through the returned context', () => {
    const ctx = withExtensionIdentifier(context.active(), 'io.stagewise/test');
    expect(getExtensionIdentifier(ctx)).toBe('io.stagewise/test');
  });

  it('reading from the root context returns undefined', () => {
    expect(getExtensionIdentifier(context.active())).toBeUndefined();
  });

  it('isolates identifiers across separate contexts', () => {
    const outerCtx = withExtensionIdentifier(
      context.active(),
      'io.stagewise/outer',
    );
    const innerCtx = withExtensionIdentifier(outerCtx, 'io.stagewise/inner');

    expect(getExtensionIdentifier(outerCtx)).toBe('io.stagewise/outer');
    expect(getExtensionIdentifier(innerCtx)).toBe('io.stagewise/inner');
    // The outer context is not mutated by creating an inner context.
    expect(getExtensionIdentifier(outerCtx)).toBe('io.stagewise/outer');
  });

  it('accepts an explicit context argument', () => {
    const ctx = withExtensionIdentifier(
      context.active(),
      'io.stagewise/explicit',
    );
    expect(getExtensionIdentifier(ctx)).toBe('io.stagewise/explicit');
  });

  it('returns a value that is a valid OTel Context', () => {
    const ctx = withExtensionIdentifier(context.active(), 'io.stagewise/test');
    expect(typeof ctx.setValue).toBe('function');
    expect(typeof ctx.getValue).toBe('function');
  });
});

describe('tracing — startChildSpan', () => {
  it('creates a span with the given name', () => {
    const span = startChildSpan('test.span');
    expect(span).toBeDefined();
    expect(typeof span.end).toBe('function');
    span.end();
  });
});

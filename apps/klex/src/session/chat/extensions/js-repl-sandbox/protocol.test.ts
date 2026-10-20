import { describe, expect, it } from 'vitest';

import { parseParentMessage, parseWorkerMessage } from './protocol';

describe('JavaScript sandbox protocol', () => {
  it('separates initialization from repeated executions', () => {
    expect(parseParentMessage({ type: 'initialize' })).toEqual({
      type: 'initialize',
    });
    expect(
      parseParentMessage({
        type: 'execute',
        executionId: 'execution-2',
        source: 'console.log(null)',
        deadline: 1,
        snapshot: { namespaces: [] },
      }).type,
    ).toBe('execute');
  });

  it('parses correlated provider requests', () => {
    expect(
      parseWorkerMessage({
        type: 'provider-request',
        executionId: 'execution',
        requestId: 'request',
        request: { operation: 'search', query: 'pull requests' },
      }).type,
    ).toBe('provider-request');
  });

  it.each([
    {},
    { includeInputSchema: false },
    { includeInputSchema: true },
    { includeInputSchema: true, limit: 20 },
    { limit: 100 },
  ])('parses search options %j', (options) => {
    const request = { operation: 'search', query: 'deployment', ...options };
    expect(
      parseWorkerMessage({
        type: 'provider-request',
        executionId: 'e',
        requestId: 'r',
        request,
      }),
    ).toEqual({
      type: 'provider-request',
      executionId: 'e',
      requestId: 'r',
      request,
    });
  });

  it.each(['', '   '])(
    'accepts empty or whitespace search query %j',
    (query) => {
      const message = {
        type: 'provider-request',
        executionId: 'e',
        requestId: 'r',
        request: { operation: 'search', query },
      };
      expect(parseWorkerMessage(message)).toEqual(message);
    },
  );

  it.each([{}, { query: 123 }, { query: null }, { query: {} }])(
    'rejects non-string search query %j',
    (fields) => {
      expect(() =>
        parseWorkerMessage({
          type: 'provider-request',
          executionId: 'e',
          requestId: 'r',
          request: { operation: 'search', ...fields },
        }),
      ).toThrow(/tools\.search/);
    },
  );

  it.each([
    { includeInputSchema: 'true' },
    { includeInputSchema: null },
    { includeInputSchema: true, limit: 21 },
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: '5' },
    { limit: null },
  ])('rejects invalid search options %j', (options) => {
    expect(() =>
      parseWorkerMessage({
        type: 'provider-request',
        executionId: 'e',
        requestId: 'r',
        request: { operation: 'search', query: 'deployment', ...options },
      }),
    ).toThrow(/tools.search/);
  });

  it.each([
    null,
    {},
    { type: 'unknown', executionId: 'execution' },
    { type: 'complete', executionId: '', result: null },
    { type: 'failure', executionId: 'execution', error: { message: 'x' } },
    {
      type: 'failure',
      executionId: 'execution',
      error: { name: 'Error', message: 'x' },
      fatal: 'yes',
    },
  ])('rejects malformed worker message', (message) => {
    expect(() => parseWorkerMessage(message)).toThrow();
  });
});

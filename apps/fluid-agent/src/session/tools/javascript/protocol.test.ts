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
        source: 'output(null)',
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

import { describe, expect, it } from 'vitest';

import { createEnvironmentId } from './identity';

describe('identity', () => {
  it('creates a valid environment ID', () => {
    expect(createEnvironmentId('example-1')).toBe('example-1');
  });

  it('rejects an empty environment ID', () => {
    expect(() => createEnvironmentId('')).toThrow('must not be empty');
  });

  it('rejects whitespace around an environment ID', () => {
    expect(() => createEnvironmentId(' example-1 ')).toThrow(
      'must not have leading or trailing whitespace',
    );
  });
});

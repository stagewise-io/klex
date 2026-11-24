import { describe, expect, it } from 'vitest';

import { createInvocationEvidence } from './invocation-evidence';

const invocation = (id: string, text = 'value') => ({
  id,
  executionId: 'execution',
  namespace: 'test',
  name: 'call',
  input: { text },
});
describe('invocation evidence limits', () => {
  it('caps count and retains an explicit omission marker', () => {
    const evidence = createInvocationEvidence();
    for (let index = 0; index < 60; index++)
      evidence.add(invocation(String(index)));
    expect(evidence.values()).toHaveLength(51);
    expect(evidence.values().at(-1)?.input).toMatchObject({
      omittedInvocations: 10,
    });
  });
  it('caps aggregate UTF-8 bytes including the omission marker', () => {
    const evidence = createInvocationEvidence();
    for (let index = 0; index < 60; index++)
      evidence.add(invocation(String(index), '😀'.repeat(20000)));
    expect(
      Buffer.byteLength(JSON.stringify(evidence.values())),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(evidence.values().at(-1)?.input).toMatchObject({
      omittedInvocations: 57,
    });
  });
  it('snapshots admitted inputs, deduplicates and aggregates nested omissions', () => {
    const evidence = createInvocationEvidence();
    const input = invocation('one');
    evidence.add(input);
    input.input.text = 'changed';
    evidence.add(input);
    const nested = createInvocationEvidence();
    for (let index = 0; index < 60; index++)
      nested.add(invocation(String(index)));
    for (const entry of nested.values()) evidence.add(entry);
    expect(evidence.values()[0]?.input.text).toBe('value');
    expect(evidence.values().at(-1)?.input).toMatchObject({
      omittedInvocations: 11,
    });
  });
});

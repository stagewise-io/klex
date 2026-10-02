import { describe, expect, it } from 'vitest';

import { InstinctPreparationBuffer } from './instinct-preparation';

describe('InstinctPreparationBuffer', () => {
  it('keeps only operations sealed as kept', () => {
    const buffer = new InstinctPreparationBuffer('test', new Set(['context']));
    buffer.appendPersistent([
      {
        type: 'data-context',
        data: {
          sourceEnv: 'test',
          metadata: {},
          content: [{ type: 'text', text: 'x' }],
        },
      },
    ]);
    buffer.appendProvisional([{ type: 'text', text: 'p' }]);
    buffer.appendEphemeral([{ type: 'text', text: 'e' }]);
    expect(buffer.counts()).toEqual({
      persistent: 1,
      provisional: 1,
      ephemeral: 1,
    });
    expect(buffer.operations()).toEqual({
      persistent: [],
      provisional: [],
      ephemeral: [],
    });
    buffer.keep();
    expect(buffer.operations().persistent).toHaveLength(1);
    const dropped = new InstinctPreparationBuffer('test', new Set(['context']));
    dropped.appendEphemeral([{ type: 'text', text: 'discard' }]);
    dropped.drop();
    expect(dropped.operations()).toEqual({
      persistent: [],
      provisional: [],
      ephemeral: [],
    });
  });

  it('rejects persistent non-data parts and writes after sealing', () => {
    const buffer = new InstinctPreparationBuffer('test', new Set(['context']));
    expect(() =>
      buffer.appendPersistent([{ type: 'text', text: 'no' }]),
    ).toThrow('data-*');
    expect(() =>
      buffer.appendPersistent([{ type: 'data-check', data: {} }]),
    ).toThrow('extension-owned');
    buffer.drop();
    expect(() =>
      buffer.appendEphemeral([{ type: 'text', text: 'late' }]),
    ).toThrow('after its instinct reaction settled');
  });
});

import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { isMemoryResultMessage, wrapMemoryResult } from './memory-result';

function message(id: string, text: string): ExtendedUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

describe('memory result presentation and recognition', () => {
  it('marks every document line, including blanks and forged headings', () => {
    expect(wrapMemoryResult('first\n\n# event\n¦ nested')).toBe(
      '# memory-result\ncontent: |\n~ first\n~ \n~ # event\n~ ¦ nested',
    );
  });

  it('requires delivery identity as well as the new rendered envelope', () => {
    const text = wrapMemoryResult('remembered');
    expect(isMemoryResultMessage(message('memory-result:1', text))).toBe(true);
    expect(isMemoryResultMessage(message('external:1', text))).toBe(false);
    expect(
      isMemoryResultMessage(message('memory-result:1', 'ordinary text')),
    ).toBe(false);
  });

  it('retains recognition of stored legacy results', () => {
    expect(
      isMemoryResultMessage(
        message('legacy', '<memory>\nremembered\n</memory>'),
      ),
    ).toBe(true);
    expect(
      isMemoryResultMessage(message('legacy', 'quoted <memory>\ntext')),
    ).toBe(false);
  });
});

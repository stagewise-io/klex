import { describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { renderFittedMessage } from '@/session/chat/utils/history-view';

import { writerView } from './view';

vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: 'Time.',
}));

const tool = (toolName: string, input: unknown, output: unknown) =>
  ({
    type: 'dynamic-tool',
    toolCallId: `${toolName}-call`,
    toolName,
    input,
    output,
    state: 'output-available',
  }) as never;

const render = (parts: ExtendedUIMessage['parts']) =>
  writerView([{ id: 'm', role: 'assistant', parts }]).messages.map(
    (message) => renderFittedMessage(message).text,
  );

describe('memory writer view', () => {
  // The writer prompt and LINES_FORMAT_PROMPT describe this shape.
  it('renders self records in the line format', () => {
    const [text] = render([
      { type: 'text', text: 'Checking the diff' },
      tool('runCommand', { command: 'git diff' }, 'ok'),
    ]);
    const [output, action] = text?.split('\n\n') ?? [];
    expect(output).toBe('# your_output\ncontent: |\n~ Checking the diff');
    expect(action).toMatch(
      /^# your_action\ntool: runCommand\nstatus: succeeded\ninput: \|\n~ /,
    );
    expect(action).toContain('git diff');
    expect(action).toMatch(/\nresult: \|\n¦ ok$/);
  });

  it('hides todo tools', () => {
    expect(
      render([
        tool('createTodo', { title: 'x' }, 'list'),
        tool('changeTodoReminder', {}, 'list'),
        tool('clearTodo', {}, 'list'),
      ]),
    ).toEqual([]);
  });

  it('strips terminal codes, unwraps text output and masks tokens', () => {
    const [text] = render([
      tool(
        'runCommand',
        { command: 'git diff' },
        {
          text: '\u001b[?2004l\r\u001b[1mdiff --git a/x b/x\u001b[m\r\ntoken ghs_abcdefghijklmnopqrstuvwxyz123456',
        },
      ),
    ]);
    expect(text).toContain('diff --git a/x b/x');
    expect(text).toContain('token [secret]');
    expect(text).not.toMatch(/\[\?2004l|\[1m|\\u001b|\\r|"text"|ghs_/);
  });

  it('keeps the tail when an unterminated escape sits in the omitted middle', () => {
    const [text] = render([
      tool(
        'runCommand',
        {},
        `HEAD${'a'.repeat(9_000)}\u001b]${'b'.repeat(30_000)}TAIL`,
      ),
    ]);
    expect(text).toContain('HEAD');
    expect(text).toContain('TAIL');
  });

  it('bounds tool input and output', () => {
    const [text] = render([
      tool('runCommand', { code: 'Q'.repeat(3_000) }, 'J'.repeat(3_000)),
    ]);
    expect(text?.match(/Q/g)?.length).toBeLessThan(400);
    expect(text?.match(/J/g)?.length).toBeGreaterThan(500);
    expect(text?.match(/J/g)?.length).toBeLessThan(1_200);
  });
});

import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/types';

import { checkAndFixHistory } from './check-and-fix-history';

// --- fixtures ---

function makeMessage(
  role: 'user' | 'assistant',
  parts: ExtendedUIMessage['parts'],
): ExtendedUIMessage {
  return {
    id: 'msg-1',
    role,
    parts,
  } as ExtendedUIMessage;
}

function makeToolPart(
  state: string,
  toolCallId = 'call-1',
): ExtendedUIMessage['parts'][number] {
  return {
    type: 'tool-testTool' as never,
    toolCallId,
    state,
    input: {},
    providerExecuted: false,
  } as ExtendedUIMessage['parts'][number];
}

function makeTextPart(text: string): ExtendedUIMessage['parts'][number] {
  return { type: 'text', text } as ExtendedUIMessage['parts'][number];
}

// --- tests ---

describe('checkAndFixHistory', () => {
  it('fixes input-streaming tool calls to output-error', () => {
    const history = [
      makeMessage('assistant', [makeToolPart('input-streaming')]),
    ];
    checkAndFixHistory(history);
    const part = history[0]!.parts[0] as Record<string, unknown>;
    expect(part.state).toBe('output-error');
    expect(part.errorText).toBe(
      'The tool call was not executed for unknown reasons. Try again.',
    );
  });

  it('fixes input-available tool calls to output-error', () => {
    const history = [
      makeMessage('assistant', [makeToolPart('input-available')]),
    ];
    checkAndFixHistory(history);
    expect((history[0]!.parts[0] as Record<string, unknown>).state).toBe(
      'output-error',
    );
  });

  it('fixes approval-requested tool calls to output-error', () => {
    const history = [
      makeMessage('assistant', [makeToolPart('approval-requested')]),
    ];
    checkAndFixHistory(history);
    expect((history[0]!.parts[0] as Record<string, unknown>).state).toBe(
      'output-error',
    );
  });

  it('does not modify output-available tool calls', () => {
    const history = [
      makeMessage('assistant', [makeToolPart('output-available')]),
    ];
    checkAndFixHistory(history);
    expect((history[0]!.parts[0] as Record<string, unknown>).state).toBe(
      'output-available',
    );
  });

  it('does not modify output-error tool calls', () => {
    const history = [makeMessage('assistant', [makeToolPart('output-error')])];
    checkAndFixHistory(history);
    expect((history[0]!.parts[0] as Record<string, unknown>).state).toBe(
      'output-error',
    );
  });

  it('does not modify output-denied tool calls', () => {
    const history = [makeMessage('assistant', [makeToolPart('output-denied')])];
    checkAndFixHistory(history);
    expect((history[0]!.parts[0] as Record<string, unknown>).state).toBe(
      'output-denied',
    );
  });

  it('does not modify approval-responded tool calls', () => {
    const history = [
      makeMessage('assistant', [makeToolPart('approval-responded')]),
    ];
    checkAndFixHistory(history);
    expect((history[0]!.parts[0] as Record<string, unknown>).state).toBe(
      'approval-responded',
    );
  });

  it('does not modify non-tool parts', () => {
    const history = [
      makeMessage('user', [makeTextPart('hello')]),
      makeMessage('assistant', [makeTextPart('response')]),
    ];
    checkAndFixHistory(history);
    expect(history[0]!.parts[0]).toEqual(makeTextPart('hello'));
    expect(history[1]!.parts[0]).toEqual(makeTextPart('response'));
  });

  it('handles mixed tool and text parts in the same message', () => {
    const history = [
      makeMessage('assistant', [
        makeTextPart('response'),
        makeToolPart('input-streaming'),
        makeToolPart('output-available'),
      ]),
    ];
    checkAndFixHistory(history);
    expect(history[0]!.parts[0]).toEqual(makeTextPart('response'));
    expect((history[0]!.parts[1] as Record<string, unknown>).state).toBe(
      'output-error',
    );
    expect((history[0]!.parts[2] as Record<string, unknown>).state).toBe(
      'output-available',
    );
  });

  it('handles empty history', () => {
    expect(() => checkAndFixHistory([])).not.toThrow();
  });

  it('handles messages with empty parts', () => {
    const history = [makeMessage('assistant', [])];
    expect(() => checkAndFixHistory(history)).not.toThrow();
  });

  it('fixes multiple messages with multiple tool calls', () => {
    const history = [
      makeMessage('assistant', [
        makeToolPart('input-streaming', 'call-1'),
        makeToolPart('input-available', 'call-2'),
      ]),
      makeMessage('assistant', [makeToolPart('approval-requested', 'call-3')]),
    ];
    checkAndFixHistory(history);
    expect((history[0]!.parts[0] as Record<string, unknown>).state).toBe(
      'output-error',
    );
    expect((history[0]!.parts[1] as Record<string, unknown>).state).toBe(
      'output-error',
    );
    expect((history[1]!.parts[0] as Record<string, unknown>).state).toBe(
      'output-error',
    );
  });
});

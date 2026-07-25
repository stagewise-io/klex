import { describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/types';

import { repairPartialMessage } from './repair-partial-message';

// --- fixtures ---

function makeMessage(parts: ExtendedUIMessage['parts']): ExtendedUIMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    parts,
  } as ExtendedUIMessage;
}

function makeToolPart(
  toolCallId: string,
  state: string,
  toolName = 'testTool',
): ExtendedUIMessage['parts'][number] {
  return {
    type: `tool-${toolName}` as never,
    toolCallId,
    state,
    input: {},
    providerExecuted: false,
  } as ExtendedUIMessage['parts'][number];
}

function makeTextPart(text: string): ExtendedUIMessage['parts'][number] {
  return { type: 'text', text } as ExtendedUIMessage['parts'][number];
}

function makeReasoningPart(
  text = 'thinking...',
): ExtendedUIMessage['parts'][number] {
  return { type: 'reasoning', text } as ExtendedUIMessage['parts'][number];
}

function makeReasoningFilePart(): ExtendedUIMessage['parts'][number] {
  return {
    type: 'reasoning-file',
    mimeType: 'text/plain',
    mediaType: 'text/plain',
    url: 'data:text/plain;base64,aGVsbG8=',
  } as unknown as ExtendedUIMessage['parts'][number];
}

// --- tests ---

describe('repairPartialMessage — salvage decision', () => {
  it('returns true when message has a fully streamed tool call', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeToolPart('call-1', 'input-available'),
    ]);
    expect(repairPartialMessage(msg)).toBe(true);
  });

  it('returns true when message has a completed tool call (output-available)', () => {
    const msg = makeMessage([makeToolPart('call-1', 'output-available')]);
    expect(repairPartialMessage(msg)).toBe(true);
  });

  it('returns true when message has text content', () => {
    const msg = makeMessage([makeTextPart('hello world')]);
    expect(repairPartialMessage(msg)).toBe(true);
  });

  it('returns true when message has multiple parts', () => {
    const msg = makeMessage([
      makeReasoningPart('step 1'),
      makeTextPart('result'),
    ]);
    expect(repairPartialMessage(msg)).toBe(true);
  });

  it('returns false when message has only reasoning parts', () => {
    const msg = makeMessage([makeReasoningPart('just thinking')]);
    expect(repairPartialMessage(msg)).toBe(false);
  });

  it('returns false when message has no parts', () => {
    const msg = makeMessage([]);
    expect(repairPartialMessage(msg)).toBe(false);
  });
});

describe('repairPartialMessage — removeBrokenParts: streaming tool calls', () => {
  it('removes streaming tool calls and keeps the rest', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeToolPart('call-1', 'input-streaming'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toEqual(makeTextPart('response'));
  });

  it('removes multiple streaming tool calls', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeToolPart('call-1', 'input-streaming'),
      makeToolPart('call-2', 'input-streaming'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toEqual(makeTextPart('response'));
  });

  it('keeps non-streaming tool calls (output-available)', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeToolPart('call-1', 'output-available'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(2);
  });

  it('keeps non-streaming tool calls (output-error)', () => {
    const msg = makeMessage([makeToolPart('call-1', 'output-error')]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(1);
  });

  it('removes streaming tool calls but keeps completed ones in the same message', () => {
    const msg = makeMessage([
      makeToolPart('call-1', 'output-available'),
      makeToolPart('call-2', 'input-streaming'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(1);
    expect((msg.parts[0] as { toolCallId: string }).toolCallId).toBe('call-1');
  });

  it('results in empty parts when all parts are streaming tool calls', () => {
    const msg = makeMessage([
      makeToolPart('call-1', 'input-streaming'),
      makeToolPart('call-2', 'input-streaming'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(0);
  });
});

describe('repairPartialMessage — removeBrokenParts: trailing reasoning', () => {
  it('removes a single trailing reasoning part', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeReasoningPart('afterthought'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toEqual(makeTextPart('response'));
  });

  it('removes multiple consecutive trailing reasoning parts', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeReasoningPart('thought 1'),
      makeReasoningPart('thought 2'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toEqual(makeTextPart('response'));
  });

  it('removes trailing reasoning-file parts', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeReasoningFilePart(),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toEqual(makeTextPart('response'));
  });

  it('removes mixed trailing reasoning and reasoning-file parts', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeReasoningPart('thought'),
      makeReasoningFilePart(),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toEqual(makeTextPart('response'));
  });

  it('keeps reasoning parts that are not at the end', () => {
    const msg = makeMessage([
      makeReasoningPart('initial thought'),
      makeTextPart('response'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[0]).toEqual(makeReasoningPart('initial thought'));
    expect(msg.parts[1]).toEqual(makeTextPart('response'));
  });
});

describe('repairPartialMessage — removeBrokenParts: combined', () => {
  it('removes streaming tool calls AND trailing reasoning, keeps the rest', () => {
    const msg = makeMessage([
      makeReasoningPart('planning'),
      makeTextPart('response'),
      makeToolPart('call-1', 'input-streaming'),
      makeReasoningPart('trailing thought'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[0]).toEqual(makeReasoningPart('planning'));
    expect(msg.parts[1]).toEqual(makeTextPart('response'));
  });

  it('removes trailing reasoning, then streaming tool calls exposed by that removal', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeToolPart('call-1', 'input-streaming'),
      makeReasoningPart('trailing'),
    ]);
    repairPartialMessage(msg);
    // Trailing reasoning removed, then streaming tool call removed
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toEqual(makeTextPart('response'));
  });

  it('keeps completed tool calls even when they appear before trailing reasoning', () => {
    const msg = makeMessage([
      makeTextPart('response'),
      makeToolPart('call-1', 'output-available'),
      makeReasoningPart('afterthought'),
    ]);
    repairPartialMessage(msg);
    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[0]).toEqual(makeTextPart('response'));
    expect((msg.parts[1] as { toolCallId: string }).toolCallId).toBe('call-1');
  });
});

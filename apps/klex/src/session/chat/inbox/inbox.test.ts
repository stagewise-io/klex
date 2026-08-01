import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { testLogger as drainLogger } from '../test-helpers';
import {
  createInbox,
  redactMediaForTelemetry,
  type SessionInboxBuffer,
  type SessionInboxEvent,
  SessionInboxPriority,
} from './inbox';

// --- fixtures ---

function makeMessage(text: string): ExtendedUIMessage {
  return {
    id: `msg-${text}`,
    role: 'user',
    parts: [{ type: 'text', text }],
  } as ExtendedUIMessage;
}

function makeEvent(
  sourceEnv: string,
  priority: SessionInboxPriority,
  text: string,
): SessionInboxEvent {
  return {
    sourceEnv,
    priority,
    context: {
      sourceEnv,
      metadata: {},
      content: [{ type: 'text', text }],
    },
  };
}

const low = (text: string) =>
  makeEvent('test-env', SessionInboxPriority.Low, text);
const medium = (text: string) =>
  makeEvent('test-env', SessionInboxPriority.Medium, text);
const high = (text: string) =>
  makeEvent('test-env', SessionInboxPriority.High, text);

// --- tests ---

describe('Inbox — factory', () => {
  it('returns an object implementing SessionInboxBuffer', () => {
    const inbox = createInbox({
      onNewEvent: vi.fn<(priority: SessionInboxPriority) => void>(),
    });
    expect(typeof inbox.send).toBe('function');
    expect(typeof inbox.getEvents).toBe('function');
  });
});

describe('Inbox — send', () => {
  let onNewEvent: ReturnType<
    typeof vi.fn<(priority: SessionInboxPriority) => void>
  >;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onNewEvent = vi.fn<(priority: SessionInboxPriority) => void>();
    inbox = createInbox({ onNewEvent });
  });

  it('stores an event without error', () => {
    inbox.send(low('hello'));
    expect(inbox.getEvents(SessionInboxPriority.Low)).toHaveLength(1);
  });

  it('calls onNewEvent with the correct priority', () => {
    inbox.send(high('urgent'));
    expect(onNewEvent).toHaveBeenCalledExactlyOnceWith(
      SessionInboxPriority.High,
    );
  });

  it('calls onNewEvent once per sent event', () => {
    inbox.send(low('a'));
    inbox.send(medium('b'));
    inbox.send(high('c'));
    expect(onNewEvent).toHaveBeenCalledTimes(3);
    expect(onNewEvent).toHaveBeenNthCalledWith(1, SessionInboxPriority.Low);
    expect(onNewEvent).toHaveBeenNthCalledWith(2, SessionInboxPriority.Medium);
    expect(onNewEvent).toHaveBeenNthCalledWith(3, SessionInboxPriority.High);
  });

  it('buffers the event even if onNewEvent throws', () => {
    onNewEvent.mockImplementation(() => {
      throw new Error('callback explosion');
    });
    expect(() => inbox.send(low('survivor'))).not.toThrow();
    expect(inbox.getEvents(SessionInboxPriority.Low)).toHaveLength(1);
  });

  it('logs the error when onNewEvent throws and a logger is provided', () => {
    const errorLogger = vi.fn();
    const logger = {
      error: errorLogger,
    } as unknown as import('@stagewise/logger').ModuleLogger;
    onNewEvent.mockImplementation(() => {
      throw new Error('callback explosion');
    });
    const throwingInbox = createInbox({ onNewEvent, logger });
    expect(() => throwingInbox.send(low('survivor'))).not.toThrow();
    expect(errorLogger).toHaveBeenCalledOnce();
  });
});

describe('Inbox — getEvents', () => {
  let onNewEvent: ReturnType<
    typeof vi.fn<(priority: SessionInboxPriority) => void>
  >;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onNewEvent = vi.fn<(priority: SessionInboxPriority) => void>();
    inbox = createInbox({ onNewEvent });
  });

  it('returns an empty array when no events have been sent', () => {
    expect(inbox.getEvents(SessionInboxPriority.Low)).toEqual([]);
  });

  it('returns only events at or above minPriority (Medium)', () => {
    inbox.send(low('a'));
    inbox.send(medium('b'));
    inbox.send(high('c'));
    const events = inbox.getEvents(SessionInboxPriority.Medium);
    expect(events).toHaveLength(2);
    expect(events[0]?.context.content[0]).toMatchObject({ text: 'b' });
    expect(events[1]?.context.content[0]).toMatchObject({ text: 'c' });
  });

  it('returns events in ascending time order (oldest first)', () => {
    inbox.send(low('first'));
    inbox.send(low('second'));
    inbox.send(low('third'));
    const events = inbox.getEvents(SessionInboxPriority.Low);
    expect(events[0]?.context.content[0]).toMatchObject({ text: 'first' });
    expect(events[1]?.context.content[0]).toMatchObject({ text: 'second' });
    expect(events[2]?.context.content[0]).toMatchObject({ text: 'third' });
  });

  it('removes returned events from the buffer', () => {
    inbox.send(low('a'));
    inbox.send(low('b'));
    inbox.getEvents(SessionInboxPriority.Low);
    expect(inbox.getEvents(SessionInboxPriority.Low)).toEqual([]);
  });

  it('preserves non-matching events in the buffer', () => {
    inbox.send(low('keep'));
    inbox.send(high('drain'));
    const drained = inbox.getEvents(SessionInboxPriority.High);
    expect(drained).toHaveLength(1);
    // Low-priority event should still be in the buffer
    const remaining = inbox.getEvents(SessionInboxPriority.Low);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.context.content[0]).toMatchObject({ text: 'keep' });
  });

  it('allows sending new events after draining', () => {
    inbox.send(low('first-batch'));
    inbox.getEvents(SessionInboxPriority.Low);
    inbox.send(high('second-batch'));
    const events = inbox.getEvents(SessionInboxPriority.Low);
    expect(events).toHaveLength(1);
    expect(events[0]?.context.content[0]).toMatchObject({
      text: 'second-batch',
    });
  });
});

// --- sendMessage / getMessages tests ---

describe('Inbox — sendMessage', () => {
  let onNewEvent: ReturnType<
    typeof vi.fn<(priority: SessionInboxPriority) => void>
  >;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onNewEvent = vi.fn<(priority: SessionInboxPriority) => void>();
    inbox = createInbox({ onNewEvent });
  });

  it('stores a message without error', () => {
    inbox.sendMessage(makeMessage('hello'), SessionInboxPriority.Low);
    expect(inbox.getMessages(SessionInboxPriority.Low)).toHaveLength(1);
  });

  it('calls onNewEvent with the correct priority', () => {
    inbox.sendMessage(makeMessage('urgent'), SessionInboxPriority.High);
    expect(onNewEvent).toHaveBeenCalledExactlyOnceWith(
      SessionInboxPriority.High,
    );
  });

  it('calls onNewEvent once per sent message', () => {
    inbox.sendMessage(makeMessage('a'), SessionInboxPriority.Low);
    inbox.sendMessage(makeMessage('b'), SessionInboxPriority.Medium);
    inbox.sendMessage(makeMessage('c'), SessionInboxPriority.High);
    expect(onNewEvent).toHaveBeenCalledTimes(3);
  });
});

describe('Inbox — getMessages', () => {
  let onNewEvent: ReturnType<
    typeof vi.fn<(priority: SessionInboxPriority) => void>
  >;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onNewEvent = vi.fn<(priority: SessionInboxPriority) => void>();
    inbox = createInbox({ onNewEvent });
  });

  it('returns an empty array when no messages have been sent', () => {
    expect(inbox.getMessages(SessionInboxPriority.Low)).toEqual([]);
  });

  it('returns only messages at or above minPriority (Medium)', () => {
    inbox.sendMessage(makeMessage('a'), SessionInboxPriority.Low);
    inbox.sendMessage(makeMessage('b'), SessionInboxPriority.Medium);
    inbox.sendMessage(makeMessage('c'), SessionInboxPriority.High);
    const messages = inbox.getMessages(SessionInboxPriority.Medium);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe('msg-b');
    expect(messages[1]?.id).toBe('msg-c');
  });

  it('returns messages in ascending time order (oldest first)', () => {
    inbox.sendMessage(makeMessage('first'), SessionInboxPriority.Low);
    inbox.sendMessage(makeMessage('second'), SessionInboxPriority.Low);
    inbox.sendMessage(makeMessage('third'), SessionInboxPriority.Low);
    const messages = inbox.getMessages(SessionInboxPriority.Low);
    expect(messages[0]?.id).toBe('msg-first');
    expect(messages[1]?.id).toBe('msg-second');
    expect(messages[2]?.id).toBe('msg-third');
  });

  it('removes returned messages from the buffer', () => {
    inbox.sendMessage(makeMessage('a'), SessionInboxPriority.Low);
    inbox.sendMessage(makeMessage('b'), SessionInboxPriority.Low);
    inbox.getMessages(SessionInboxPriority.Low);
    expect(inbox.getMessages(SessionInboxPriority.Low)).toEqual([]);
  });

  it('preserves non-matching messages in the buffer', () => {
    inbox.sendMessage(makeMessage('keep'), SessionInboxPriority.Low);
    inbox.sendMessage(makeMessage('drain'), SessionInboxPriority.High);
    const drained = inbox.getMessages(SessionInboxPriority.High);
    expect(drained).toHaveLength(1);
    const remaining = inbox.getMessages(SessionInboxPriority.Low);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe('msg-keep');
  });
});

describe('Inbox — isEmpty with mixed events and messages', () => {
  let onNewEvent: ReturnType<
    typeof vi.fn<(priority: SessionInboxPriority) => void>
  >;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onNewEvent = vi.fn<(priority: SessionInboxPriority) => void>();
    inbox = createInbox({ onNewEvent });
  });

  it('returns true when both buffers are empty', () => {
    expect(inbox.isEmpty()).toBe(true);
  });

  it('returns false when only events are present', () => {
    inbox.send(low('event'));
    expect(inbox.isEmpty()).toBe(false);
  });

  it('returns false when only messages are present', () => {
    inbox.sendMessage(makeMessage('msg'), SessionInboxPriority.Low);
    expect(inbox.isEmpty()).toBe(false);
  });

  it('returns true after both events and messages are drained', () => {
    inbox.send(low('event'));
    inbox.sendMessage(makeMessage('msg'), SessionInboxPriority.Low);
    inbox.getEvents(SessionInboxPriority.Low);
    inbox.getMessages(SessionInboxPriority.Low);
    expect(inbox.isEmpty()).toBe(true);
  });

  it('returns false when only events are drained but messages remain', () => {
    inbox.send(low('event'));
    inbox.sendMessage(makeMessage('msg'), SessionInboxPriority.Low);
    inbox.getEvents(SessionInboxPriority.Low);
    expect(inbox.isEmpty()).toBe(false);
  });
});

// --- drain tests ---

describe('Inbox — drain: empty inbox', () => {
  it('returns zero counts and does not append a message', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    const messages: ExtendedUIMessage[] = [];

    const result = inbox.drain(messages, SessionInboxPriority.Low, drainLogger);

    expect(result).toEqual({
      total: 0,
      byPriority: { low: 0, medium: 0, high: 0 },
      nativeMessages: 0,
      before: { events: 0, messages: 0 },
      remaining: { events: 0, messages: 0 },
    });
    expect(messages).toHaveLength(0);
  });

  it('leaves messages array untouched for an empty inbox at any priority', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    const messages: ExtendedUIMessage[] = [
      {
        id: 'existing',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      } as ExtendedUIMessage,
    ];

    inbox.drain(messages, SessionInboxPriority.High, drainLogger);

    expect(messages).toHaveLength(1);
  });
});

describe('Inbox — media handling', () => {
  it('preserves canonical image data while redacting telemetry projections', () => {
    const imageData = 'aW1hZ2U=';
    const event: SessionInboxEvent = {
      sourceEnv: 'telegram:1',
      priority: SessionInboxPriority.Medium,
      context: {
        sourceEnv: 'telegram:1',
        metadata: {},
        content: [{ type: 'image', mimeType: 'image/png', data: imageData }],
      },
    };
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.send(event);
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, SessionInboxPriority.Low, drainLogger);

    expect(messages[0]?.parts[0]).toMatchObject({
      type: 'data-context',
      data: { content: [{ type: 'image', data: imageData }] },
    });
    const projected = redactMediaForTelemetry(event.context);
    expect(projected).toEqual({
      sourceEnv: 'telegram:1',
      metadata: {},
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: '[redacted]',
          decodedBytes: 5,
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain(imageData);
  });

  it('preserves canonical audio data while redacting telemetry projections', () => {
    const audioData = 'YXVkaW8=';
    const event: SessionInboxEvent = {
      sourceEnv: 'telegram:1',
      priority: SessionInboxPriority.Medium,
      context: {
        sourceEnv: 'telegram:1',
        metadata: {},
        content: [{ type: 'audio', mimeType: 'audio/ogg', data: audioData }],
      },
    };
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.send(event);
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, SessionInboxPriority.Low, drainLogger);

    expect(messages[0]?.parts[0]).toMatchObject({
      type: 'data-context',
      data: { content: [{ type: 'audio', data: audioData }] },
    });
    const projected = redactMediaForTelemetry(event.context);
    expect(projected).toEqual({
      sourceEnv: 'telegram:1',
      metadata: {},
      content: [
        {
          type: 'audio',
          mimeType: 'audio/ogg',
          data: '[redacted]',
          decodedBytes: 5,
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain(audioData);
  });

  it('redacts native file data URLs', () => {
    const projected = redactMediaForTelemetry([
      {
        type: 'file',
        mediaType: 'image/png',
        url: 'data:image/png;base64,aW1hZ2U=',
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain('aW1hZ2U=');
    expect(projected).toEqual([
      {
        type: 'file',
        mediaType: 'image/png',
        url: '[redacted]',
        decodedBytes: 5,
      },
    ]);
  });

  it('replaces circular references in telemetry projections', () => {
    const circular: Record<string, unknown> = { type: 'data-custom' };
    circular.self = circular;

    const projected = redactMediaForTelemetry(circular);

    expect(projected).toEqual({
      type: 'data-custom',
      self: '[circular]',
    });
    expect(() => JSON.stringify(projected)).not.toThrow();
  });
});

describe('Inbox — drain: with events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends a single user message containing all drained events as data-context parts', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.send(low('a'));
    inbox.send(high('b'));
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, SessionInboxPriority.Low, drainLogger);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.parts).toHaveLength(2);
    expect(messages[0]?.parts[0]).toMatchObject({ type: 'data-context' });
    expect(messages[0]?.parts[1]).toMatchObject({ type: 'data-context' });
  });

  it('reports correct counts broken down by priority', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.send(low('1'));
    inbox.send(low('2'));
    inbox.send(medium('3'));
    inbox.send(high('4'));
    inbox.send(high('5'));

    const result = inbox.drain([], SessionInboxPriority.Low, drainLogger);

    expect(result.total).toBe(5);
    expect(result.byPriority).toEqual({ low: 2, medium: 1, high: 2 });
  });

  it('logs the drain operation with priority and counts', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.send(medium('a'));
    inbox.send(high('b'));

    inbox.drain([], SessionInboxPriority.Medium, drainLogger);

    expect(drainLogger.debug).toHaveBeenCalledOnce();
    const calls = vi.mocked(drainLogger.debug).mock.calls;
    const [meta, msg] = calls[calls.length - 1] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toBe('Inbox drained');
    expect(meta).toMatchObject({
      minPriority: 'Medium',
      total: 2,
      low: 0,
      medium: 1,
      high: 1,
    });
  });
});

describe('Inbox — drain: native messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends native messages to the messages array', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.sendMessage(makeMessage('a'), SessionInboxPriority.Low);
    inbox.sendMessage(makeMessage('b'), SessionInboxPriority.Low);
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, SessionInboxPriority.Low, drainLogger);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe('msg-a');
    expect(messages[1]?.id).toBe('msg-b');
  });

  it('delivers a native message with a circular custom data part', () => {
    const circularPart: Record<string, unknown> = { type: 'data-custom' };
    circularPart.self = circularPart;
    const message = {
      id: 'msg-circular',
      role: 'user',
      parts: [circularPart],
    } as unknown as ExtendedUIMessage;
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.sendMessage(message, SessionInboxPriority.Low);
    const messages: ExtendedUIMessage[] = [];

    expect(() =>
      inbox.drain(messages, SessionInboxPriority.Low, drainLogger),
    ).not.toThrow();
    expect(messages).toEqual([message]);
    expect(inbox.isEmpty()).toBe(true);
  });

  it('reports the native message count in the result', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.sendMessage(makeMessage('native-1'), SessionInboxPriority.Low);

    const result = inbox.drain([], SessionInboxPriority.Low, drainLogger);

    expect(result.nativeMessages).toBe(1);
    expect(result.total).toBe(1);
  });

  it('appends native messages before context events', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.send(low('ctx'));
    inbox.sendMessage(makeMessage('native'), SessionInboxPriority.Low);
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, SessionInboxPriority.Low, drainLogger);

    expect(messages).toHaveLength(2);
    // Native message first
    expect(messages[0]?.id).toBe('msg-native');
    expect(messages[0]?.parts[0]).toMatchObject({
      type: 'text',
      text: 'native',
    });
    // Context events bundled into one user message after native messages
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.parts).toHaveLength(1);
    expect(messages[1]?.parts[0]).toMatchObject({ type: 'data-context' });
  });

  it('total includes both events and native messages', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    inbox.send(low('ctx-1'));
    inbox.send(medium('ctx-2'));
    inbox.sendMessage(makeMessage('native-1'), SessionInboxPriority.Low);
    inbox.sendMessage(makeMessage('native-2'), SessionInboxPriority.Low);

    const result = inbox.drain([], SessionInboxPriority.Low, drainLogger);

    expect(result.total).toBe(4);
    expect(result.nativeMessages).toBe(2);
  });

  it('leaves messages array untouched when no events and no native messages', () => {
    const inbox = createInbox({ onNewEvent: vi.fn() });
    const messages: ExtendedUIMessage[] = [
      {
        id: 'existing',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      } as ExtendedUIMessage,
    ];

    inbox.drain(messages, SessionInboxPriority.High, drainLogger);

    expect(messages).toHaveLength(1);
  });
});

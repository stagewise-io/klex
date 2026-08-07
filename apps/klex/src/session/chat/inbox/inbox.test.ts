import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { testLogger as drainLogger } from '../test-helpers';
import {
  createInbox,
  type InboxDependencies,
  redactMediaForTelemetry,
  type SessionInboxBuffer,
  type SessionInboxEvent,
  SessionInboxUrgency,
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
  urgency: SessionInboxUrgency,
  text: string,
): SessionInboxEvent {
  return {
    sourceEnv,
    urgency,
    context: {
      sourceEnv,
      metadata: {},
      content: [{ type: 'text', text }],
    },
  };
}

const critical = (text: string) =>
  makeEvent('test-env', SessionInboxUrgency.Critical, text);
const defaultEvent = (text: string) =>
  makeEvent('test-env', SessionInboxUrgency.Default, text);
const deferrable = (text: string) =>
  makeEvent('test-env', SessionInboxUrgency.Deferrable, text);

function makeDeps(
  overrides: Partial<{
    onImmediateEvent: ReturnType<typeof vi.fn>;
    onImmediateMessage: ReturnType<typeof vi.fn>;
    onNewInput: ReturnType<typeof vi.fn>;
  }> = {},
): InboxDependencies {
  return {
    onImmediateEvent: overrides.onImmediateEvent ?? vi.fn(),
    onImmediateMessage: overrides.onImmediateMessage ?? vi.fn(),
    onNewInput: overrides.onNewInput ?? vi.fn(),
  } as InboxDependencies;
}

// --- tests ---

describe('Inbox — factory', () => {
  it('returns an object implementing SessionInboxBuffer', () => {
    const inbox = createInbox(makeDeps());
    expect(typeof inbox.send).toBe('function');
    expect(typeof inbox.getEvents).toBe('function');
  });
});

describe('Inbox — send', () => {
  let onImmediateEvent: ReturnType<typeof vi.fn>;
  let onImmediateMessage: ReturnType<typeof vi.fn>;
  let onNewInput: ReturnType<typeof vi.fn>;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onImmediateEvent = vi.fn();
    onImmediateMessage = vi.fn();
    onNewInput = vi.fn();
    inbox = createInbox({
      onImmediateEvent,
      onImmediateMessage,
      onNewInput,
    } as InboxDependencies);
  });

  it('buffers deferrable events and does NOT call onImmediateEvent', () => {
    inbox.send(deferrable('hello'));
    expect(inbox.getEvents()).toHaveLength(1);
    expect(onImmediateEvent).not.toHaveBeenCalled();
  });

  it('dispatches critical events immediately via onImmediateEvent and does NOT buffer', () => {
    inbox.send(critical('urgent'));
    expect(onImmediateEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ urgency: SessionInboxUrgency.Critical }),
    );
    expect(inbox.getEvents()).toEqual([]);
  });

  it('dispatches default events immediately via onImmediateEvent and does NOT buffer', () => {
    inbox.send(defaultEvent('normal'));
    expect(onImmediateEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ urgency: SessionInboxUrgency.Default }),
    );
    expect(inbox.getEvents()).toEqual([]);
  });

  it('calls onNewInput once per sent event', () => {
    inbox.send(critical('a'));
    inbox.send(defaultEvent('b'));
    inbox.send(deferrable('c'));
    expect(onNewInput).toHaveBeenCalledTimes(3);
  });

  it('passes urgency to onNewInput', () => {
    inbox.send(critical('a'));
    inbox.send(defaultEvent('b'));
    inbox.send(deferrable('c'));
    expect(onNewInput).toHaveBeenNthCalledWith(1, SessionInboxUrgency.Critical);
    expect(onNewInput).toHaveBeenNthCalledWith(2, SessionInboxUrgency.Default);
    expect(onNewInput).toHaveBeenNthCalledWith(
      3,
      SessionInboxUrgency.Deferrable,
    );
  });

  it('buffers deferrable events even if onImmediateEvent throws', () => {
    // Deferrable events don't call onImmediateEvent, so they're always safe.
    expect(() => inbox.send(deferrable('survivor'))).not.toThrow();
    expect(inbox.getEvents()).toHaveLength(1);
  });

  it('logs the error when onImmediateEvent throws and a logger is provided', () => {
    const errorLogger = vi.fn();
    const logger = {
      error: errorLogger,
    } as unknown as import('@stagewise/logger').ModuleLogger;
    onImmediateEvent.mockImplementation(() => {
      throw new Error('callback explosion');
    });
    const throwingInbox = createInbox({
      onImmediateEvent,
      onImmediateMessage,
      onNewInput,
      logger,
    } as InboxDependencies);
    expect(() => throwingInbox.send(critical('survivor'))).not.toThrow();
    expect(errorLogger).toHaveBeenCalledOnce();
  });

  it('does not buffer immediate events even if onImmediateEvent throws', () => {
    onImmediateEvent.mockImplementation(() => {
      throw new Error('callback explosion');
    });
    expect(() => inbox.send(critical('lost'))).not.toThrow();
    expect(inbox.getEvents()).toEqual([]);
  });
});

describe('Inbox — getEvents', () => {
  let onImmediateEvent: ReturnType<typeof vi.fn>;
  let onImmediateMessage: ReturnType<typeof vi.fn>;
  let onNewInput: ReturnType<typeof vi.fn>;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onImmediateEvent = vi.fn();
    onImmediateMessage = vi.fn();
    onNewInput = vi.fn();
    inbox = createInbox({
      onImmediateEvent,
      onImmediateMessage,
      onNewInput,
    } as InboxDependencies);
  });

  it('returns an empty array when no deferrable events have been sent', () => {
    expect(inbox.getEvents()).toEqual([]);
  });

  it('returns all deferrable events in ascending time order (oldest first)', () => {
    inbox.send(deferrable('first'));
    inbox.send(deferrable('second'));
    inbox.send(deferrable('third'));
    const events = inbox.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0]?.context.content[0]).toMatchObject({ text: 'first' });
    expect(events[1]?.context.content[0]).toMatchObject({ text: 'second' });
    expect(events[2]?.context.content[0]).toMatchObject({ text: 'third' });
  });

  it('removes returned events from the buffer', () => {
    inbox.send(deferrable('a'));
    inbox.send(deferrable('b'));
    inbox.getEvents();
    expect(inbox.getEvents()).toEqual([]);
  });

  it('does not return immediate events (they bypass the buffer)', () => {
    inbox.send(critical('immediate-1'));
    inbox.send(defaultEvent('immediate-2'));
    inbox.send(deferrable('buffered-1'));
    const events = inbox.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.context.content[0]).toMatchObject({
      text: 'buffered-1',
    });
  });

  it('allows sending new events after draining', () => {
    inbox.send(deferrable('first-batch'));
    inbox.getEvents();
    inbox.send(deferrable('second-batch'));
    const events = inbox.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.context.content[0]).toMatchObject({
      text: 'second-batch',
    });
  });
});

// --- sendMessage / getMessages tests ---

describe('Inbox — sendMessage', () => {
  let onImmediateEvent: ReturnType<typeof vi.fn>;
  let onImmediateMessage: ReturnType<typeof vi.fn>;
  let onNewInput: ReturnType<typeof vi.fn>;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onImmediateEvent = vi.fn();
    onImmediateMessage = vi.fn();
    onNewInput = vi.fn();
    inbox = createInbox({
      onImmediateEvent,
      onImmediateMessage,
      onNewInput,
    } as InboxDependencies);
  });

  it('buffers deferrable messages and does NOT call onImmediateMessage', () => {
    inbox.sendMessage(makeMessage('hello'), SessionInboxUrgency.Deferrable);
    expect(inbox.getMessages()).toHaveLength(1);
    expect(onImmediateMessage).not.toHaveBeenCalled();
  });

  it('dispatches critical messages immediately via onImmediateMessage with urgency', () => {
    inbox.sendMessage(makeMessage('urgent'), SessionInboxUrgency.Critical);
    expect(onImmediateMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'msg-urgent' }),
      SessionInboxUrgency.Critical,
    );
    expect(inbox.getMessages()).toEqual([]);
  });

  it('dispatches default messages immediately via onImmediateMessage with urgency', () => {
    inbox.sendMessage(makeMessage('normal'), SessionInboxUrgency.Default);
    expect(onImmediateMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'msg-normal' }),
      SessionInboxUrgency.Default,
    );
    expect(inbox.getMessages()).toEqual([]);
  });

  it('calls onNewInput once per sent message', () => {
    inbox.sendMessage(makeMessage('a'), SessionInboxUrgency.Critical);
    inbox.sendMessage(makeMessage('b'), SessionInboxUrgency.Default);
    inbox.sendMessage(makeMessage('c'), SessionInboxUrgency.Deferrable);
    expect(onNewInput).toHaveBeenCalledTimes(3);
  });

  it('passes urgency to onNewInput for sendMessage', () => {
    inbox.sendMessage(makeMessage('a'), SessionInboxUrgency.Critical);
    inbox.sendMessage(makeMessage('b'), SessionInboxUrgency.Default);
    inbox.sendMessage(makeMessage('c'), SessionInboxUrgency.Deferrable);
    expect(onNewInput).toHaveBeenNthCalledWith(1, SessionInboxUrgency.Critical);
    expect(onNewInput).toHaveBeenNthCalledWith(2, SessionInboxUrgency.Default);
    expect(onNewInput).toHaveBeenNthCalledWith(
      3,
      SessionInboxUrgency.Deferrable,
    );
  });
});

describe('Inbox — getMessages', () => {
  let onImmediateEvent: ReturnType<typeof vi.fn>;
  let onImmediateMessage: ReturnType<typeof vi.fn>;
  let onNewInput: ReturnType<typeof vi.fn>;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onImmediateEvent = vi.fn();
    onImmediateMessage = vi.fn();
    onNewInput = vi.fn();
    inbox = createInbox({
      onImmediateEvent,
      onImmediateMessage,
      onNewInput,
    } as InboxDependencies);
  });

  it('returns an empty array when no deferrable messages have been sent', () => {
    expect(inbox.getMessages()).toEqual([]);
  });

  it('returns all deferrable messages in ascending time order (oldest first)', () => {
    inbox.sendMessage(makeMessage('first'), SessionInboxUrgency.Deferrable);
    inbox.sendMessage(makeMessage('second'), SessionInboxUrgency.Deferrable);
    inbox.sendMessage(makeMessage('third'), SessionInboxUrgency.Deferrable);
    const messages = inbox.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0]?.id).toBe('msg-first');
    expect(messages[1]?.id).toBe('msg-second');
    expect(messages[2]?.id).toBe('msg-third');
  });

  it('removes returned messages from the buffer', () => {
    inbox.sendMessage(makeMessage('a'), SessionInboxUrgency.Deferrable);
    inbox.sendMessage(makeMessage('b'), SessionInboxUrgency.Deferrable);
    inbox.getMessages();
    expect(inbox.getMessages()).toEqual([]);
  });

  it('does not return immediate messages (they bypass the buffer)', () => {
    inbox.sendMessage(makeMessage('immediate'), SessionInboxUrgency.Critical);
    inbox.sendMessage(makeMessage('buffered'), SessionInboxUrgency.Deferrable);
    const messages = inbox.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('msg-buffered');
  });
});

describe('Inbox — isEmpty with mixed events and messages', () => {
  let onImmediateEvent: ReturnType<typeof vi.fn>;
  let onImmediateMessage: ReturnType<typeof vi.fn>;
  let onNewInput: ReturnType<typeof vi.fn>;
  let inbox: SessionInboxBuffer;

  beforeEach(() => {
    onImmediateEvent = vi.fn();
    onImmediateMessage = vi.fn();
    onNewInput = vi.fn();
    inbox = createInbox({
      onImmediateEvent,
      onImmediateMessage,
      onNewInput,
    } as InboxDependencies);
  });

  it('returns true when both buffers are empty', () => {
    expect(inbox.isEmpty()).toBe(true);
  });

  it('returns false when only deferred events are present', () => {
    inbox.send(deferrable('event'));
    expect(inbox.isEmpty()).toBe(false);
  });

  it('returns false when only deferred messages are present', () => {
    inbox.sendMessage(makeMessage('msg'), SessionInboxUrgency.Deferrable);
    expect(inbox.isEmpty()).toBe(false);
  });

  it('returns true when no deferrable items remain (immediate items do not affect isEmpty)', () => {
    inbox.send(critical('event'));
    inbox.sendMessage(makeMessage('msg'), SessionInboxUrgency.Default);
    expect(inbox.isEmpty()).toBe(true);
  });

  it('returns true after both deferred events and messages are drained', () => {
    inbox.send(deferrable('event'));
    inbox.sendMessage(makeMessage('msg'), SessionInboxUrgency.Deferrable);
    inbox.getEvents();
    inbox.getMessages();
    expect(inbox.isEmpty()).toBe(true);
  });

  it('returns false when only events are drained but messages remain', () => {
    inbox.send(deferrable('event'));
    inbox.sendMessage(makeMessage('msg'), SessionInboxUrgency.Deferrable);
    inbox.getEvents();
    expect(inbox.isEmpty()).toBe(false);
  });
});

// --- drain tests ---

describe('Inbox — drain: empty inbox', () => {
  it('returns zero counts and does not append a message', () => {
    const inbox = createInbox(makeDeps());
    const messages: ExtendedUIMessage[] = [];

    const result = inbox.drain(messages, drainLogger);

    expect(result).toEqual({
      total: 0,
      deferredEvents: 0,
      nativeMessages: 0,
      before: { events: 0, messages: 0 },
      remaining: { events: 0, messages: 0 },
    });
    expect(messages).toHaveLength(0);
  });

  it('leaves messages array untouched for an empty inbox', () => {
    const inbox = createInbox(makeDeps());
    const messages: ExtendedUIMessage[] = [
      {
        id: 'existing',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      } as ExtendedUIMessage,
    ];

    inbox.drain(messages, drainLogger);

    expect(messages).toHaveLength(1);
  });
});

describe('Inbox — media handling', () => {
  it('preserves canonical image data while redacting telemetry projections', () => {
    const imageData = 'aW1hZ2U=';
    const event: SessionInboxEvent = {
      sourceEnv: 'telegram:1',
      urgency: SessionInboxUrgency.Deferrable,
      context: {
        sourceEnv: 'telegram:1',
        metadata: {},
        content: [{ type: 'image', mimeType: 'image/png', data: imageData }],
      },
    };
    const inbox = createInbox(makeDeps());
    inbox.send(event);
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, drainLogger);

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
      urgency: SessionInboxUrgency.Deferrable,
      context: {
        sourceEnv: 'telegram:1',
        metadata: {},
        content: [{ type: 'audio', mimeType: 'audio/ogg', data: audioData }],
      },
    };
    const inbox = createInbox(makeDeps());
    inbox.send(event);
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, drainLogger);

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

describe('Inbox — drain: with deferred events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends a single user message containing all drained events as data-context parts', () => {
    const inbox = createInbox(makeDeps());
    inbox.send(deferrable('a'));
    inbox.send(deferrable('b'));
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, drainLogger);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.parts).toHaveLength(2);
    expect(messages[0]?.parts[0]).toMatchObject({ type: 'data-context' });
    expect(messages[0]?.parts[1]).toMatchObject({ type: 'data-context' });
  });

  it('reports correct counts for deferred events', () => {
    const inbox = createInbox(makeDeps());
    inbox.send(deferrable('1'));
    inbox.send(deferrable('2'));
    inbox.send(critical('3')); // immediate, not buffered
    inbox.send(defaultEvent('4')); // immediate, not buffered

    const result = inbox.drain([], drainLogger);

    expect(result.total).toBe(2);
    expect(result.deferredEvents).toBe(2);
  });

  it('logs the drain operation with counts', () => {
    const inbox = createInbox(makeDeps());
    inbox.send(deferrable('a'));
    inbox.send(deferrable('b'));

    inbox.drain([], drainLogger);

    expect(drainLogger.debug).toHaveBeenCalledOnce();
    const calls = vi.mocked(drainLogger.debug).mock.calls;
    const [meta, msg] = calls[calls.length - 1] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toBe('Inbox drained');
    expect(meta).toMatchObject({
      total: 2,
      deferredEvents: 2,
      nativeMessages: 0,
    });
  });
});

describe('Inbox — drain: native messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends deferred native messages to the messages array', () => {
    const inbox = createInbox(makeDeps());
    inbox.sendMessage(makeMessage('a'), SessionInboxUrgency.Deferrable);
    inbox.sendMessage(makeMessage('b'), SessionInboxUrgency.Deferrable);
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, drainLogger);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe('msg-a');
    expect(messages[1]?.id).toBe('msg-b');
  });

  it('delivers a deferred native message with a circular custom data part', () => {
    const circularPart: Record<string, unknown> = { type: 'data-custom' };
    circularPart.self = circularPart;
    const message = {
      id: 'msg-circular',
      role: 'user',
      parts: [circularPart],
    } as unknown as ExtendedUIMessage;
    const inbox = createInbox(makeDeps());
    inbox.sendMessage(message, SessionInboxUrgency.Deferrable);
    const messages: ExtendedUIMessage[] = [];

    expect(() => inbox.drain(messages, drainLogger)).not.toThrow();
    expect(messages).toEqual([message]);
    expect(inbox.isEmpty()).toBe(true);
  });

  it('reports the native message count in the result', () => {
    const inbox = createInbox(makeDeps());
    inbox.sendMessage(makeMessage('native-1'), SessionInboxUrgency.Deferrable);

    const result = inbox.drain([], drainLogger);

    expect(result.nativeMessages).toBe(1);
    expect(result.total).toBe(1);
  });

  it('appends native messages before context events', () => {
    const inbox = createInbox(makeDeps());
    inbox.send(deferrable('ctx'));
    inbox.sendMessage(makeMessage('native'), SessionInboxUrgency.Deferrable);
    const messages: ExtendedUIMessage[] = [];

    inbox.drain(messages, drainLogger);

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
    const inbox = createInbox(makeDeps());
    inbox.send(deferrable('ctx-1'));
    inbox.send(deferrable('ctx-2'));
    inbox.sendMessage(makeMessage('native-1'), SessionInboxUrgency.Deferrable);
    inbox.sendMessage(makeMessage('native-2'), SessionInboxUrgency.Deferrable);

    const result = inbox.drain([], drainLogger);

    expect(result.total).toBe(4);
    expect(result.nativeMessages).toBe(2);
  });

  it('leaves messages array untouched when no deferred events and no deferred native messages', () => {
    const inbox = createInbox(makeDeps());
    // Send immediate items — they bypass the buffer
    inbox.send(critical('immediate'));
    inbox.sendMessage(makeMessage('immediate'), SessionInboxUrgency.Default);
    const messages: ExtendedUIMessage[] = [
      {
        id: 'existing',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      } as ExtendedUIMessage,
    ];

    inbox.drain(messages, drainLogger);

    expect(messages).toHaveLength(1);
  });
});

import type { Span } from '@opentelemetry/api';
import type { LanguageModel } from 'ai';
import { vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { DrainInboxResult, SessionInboxBuffer } from './inbox';
import type { ExtendedUIMessage } from './message-types';

export const testLogger: ModuleLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

export const emptyDrainResult: DrainInboxResult = {
  total: 0,
  byPriority: { low: 0, medium: 0, high: 0 },
  nativeMessages: 0,
  before: { events: 0, messages: 0 },
  remaining: { events: 0, messages: 0 },
};

export function makeInbox(): SessionInboxBuffer {
  return {
    send: vi.fn(),
    sendMessage: vi.fn(),
    close: vi.fn(),
    drain: vi.fn(() => emptyDrainResult),
    getEvents: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    isEmpty: vi.fn(() => true),
  };
}

export function makeExtensionHandler() {
  return {
    extensions: [],
    runHistoryTransformers: vi.fn((h: ExtendedUIMessage[], _model: never) =>
      Promise.resolve({ history: h, flags: {} }),
    ),
    runContextTransformers: vi.fn((h: never[], _model: never) =>
      Promise.resolve({ history: h, flags: {} }),
    ),
    runStepCompleteHooks: vi.fn(() =>
      Promise.resolve({ stop: false, stopReason: null }),
    ),
    getDataPartTransformers: vi.fn(() => ({})),
  };
}

export function makeModelProvider() {
  return {
    get: vi.fn().mockResolvedValue({} as LanguageModel),
    start: vi.fn(),
    close: vi.fn(),
  };
}

export function makeFallbackManager() {
  return {
    getChatModelId: vi.fn(() => 'test:model' as never),
    getFallbackIndex: vi.fn(() => 0),
    fallbackToNextModel: vi.fn(),
    recordSuccessfulGeneration: vi.fn(),
  };
}

export function makeTestSpan(): Span {
  return {
    addEvent: vi.fn(),
    setAttribute: vi.fn(),
    end: vi.fn(),
  } as unknown as Span;
}

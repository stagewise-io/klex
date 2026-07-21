import {
  assertJsonValue,
  type JsonObject,
  type JsonValue,
  type SerializedError,
} from './serialization';

export interface CapabilityReferenceMessage {
  namespace: string;
  name: string;
}

export interface CapabilitySnapshotMessage {
  namespaces: readonly {
    name: string;
    capabilities: readonly { name: string }[];
  }[];
}

export type ProviderRequest =
  | { operation: 'search'; query: string; limit?: number }
  | { operation: 'describe'; reference: CapabilityReferenceMessage }
  | {
      operation: 'invoke';
      reference: CapabilityReferenceMessage;
      input: JsonObject;
    };

export type ParentMessage =
  | { type: 'initialize' }
  | {
      type: 'execute';
      executionId: string;
      source: string;
      snapshot: CapabilitySnapshotMessage;
      deadline: number;
    }
  | {
      type: 'provider-response';
      executionId: string;
      requestId: string;
      result: JsonValue;
    }
  | {
      type: 'provider-error';
      executionId: string;
      requestId: string;
      error: SerializedError;
    };

export type WorkerMessage =
  | { type: 'ready' }
  | {
      type: 'provider-request';
      executionId: string;
      requestId: string;
      request: ProviderRequest;
    }
  | { type: 'complete'; executionId: string; result: JsonValue }
  | {
      type: 'failure';
      executionId: string;
      error: SerializedError;
      fatal: boolean;
    };

export function parseParentMessage(value: unknown): ParentMessage {
  assertJsonValue(value);
  if (!isRecord(value) || typeof value.type !== 'string')
    throw new Error('Invalid parent message');
  switch (value.type) {
    case 'initialize':
      return { type: 'initialize' };
    case 'execute':
      assertString(value.executionId, 'executionId');
      assertString(value.source, 'source');
      assertNumber(value.deadline, 'deadline');
      assertSnapshot(value.snapshot);
      return value as unknown as ParentMessage;
    case 'provider-response':
      assertIds(value);
      assertJsonValue(value.result);
      return value as unknown as ParentMessage;
    case 'provider-error':
      assertIds(value);
      assertError(value.error);
      return value as unknown as ParentMessage;
    default:
      throw new Error('Unknown parent message type');
  }
}

export function parseWorkerMessage(value: unknown): WorkerMessage {
  assertJsonValue(value);
  if (!isRecord(value) || typeof value.type !== 'string')
    throw new Error('Invalid worker message');
  if (value.type === 'ready') return { type: 'ready' };
  assertString(value.executionId, 'executionId');
  switch (value.type) {
    case 'provider-request':
      assertString(value.requestId, 'requestId');
      assertProviderRequest(value.request);
      return value as unknown as WorkerMessage;
    case 'complete':
      assertJsonValue(value.result);
      return value as unknown as WorkerMessage;
    case 'failure':
      assertError(value.error);
      if (typeof value.fatal !== 'boolean')
        throw new Error('fatal must be a boolean');
      return value as unknown as WorkerMessage;
    default:
      throw new Error('Unknown worker message type');
  }
}

function assertProviderRequest(
  value: unknown,
): asserts value is ProviderRequest {
  if (!isRecord(value) || typeof value.operation !== 'string')
    throw new Error('Invalid provider request');
  if (value.operation === 'search') {
    assertString(value.query, 'query');
    if (value.limit !== undefined) assertNumber(value.limit, 'limit');
    return;
  }
  assertReference(value.reference);
  if (value.operation === 'describe') return;
  if (value.operation === 'invoke') {
    assertJsonValue(value.input);
    if (!isRecord(value.input))
      throw new Error('Capability input must be an object');
    return;
  }
  throw new Error('Unknown provider operation');
}

function assertSnapshot(
  value: unknown,
): asserts value is CapabilitySnapshotMessage {
  if (!isRecord(value) || !Array.isArray(value.namespaces))
    throw new Error('Invalid capability snapshot');
  for (const namespace of value.namespaces) {
    if (!isRecord(namespace) || !Array.isArray(namespace.capabilities))
      throw new Error('Invalid namespace');
    assertString(namespace.name, 'namespace.name');
    for (const capability of namespace.capabilities) {
      if (!isRecord(capability)) throw new Error('Invalid capability');
      assertString(capability.name, 'capability.name');
    }
  }
}

function assertReference(
  value: unknown,
): asserts value is CapabilityReferenceMessage {
  if (!isRecord(value)) throw new Error('Invalid capability reference');
  assertString(value.namespace, 'reference.namespace');
  assertString(value.name, 'reference.name');
}

function assertError(value: unknown): asserts value is SerializedError {
  if (!isRecord(value)) throw new Error('Invalid serialized error');
  assertString(value.name, 'error.name');
  assertString(value.message, 'error.message');
  if (value.code !== undefined) assertString(value.code, 'error.code');
}

function assertIds(value: Record<string, unknown>): void {
  assertString(value.executionId, 'executionId');
  assertString(value.requestId, 'requestId');
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${name} must be a non-empty string`);
}

function assertNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${name} must be finite`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

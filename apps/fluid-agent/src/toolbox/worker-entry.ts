import { parentPort } from 'node:worker_threads';

import {
  type ParentMessage,
  type ProviderRequest,
  parseParentMessage,
  type WorkerMessage,
} from './protocol';
import {
  createQuickJsRuntime,
  FatalQuickJsError,
  type PersistentQuickJsRuntime,
} from './quickjs-runtime';
import { type JsonValue, toSerializedError } from './serialization';
import { TOOLBOX_LIMITS } from './toolbox';

if (!parentPort) throw new Error('Toolbox Worker requires a parent port');

const port = parentPort;
const pending = new Map<
  string,
  {
    executionId: string;
    resolve(value: JsonValue): void;
    reject(error: unknown): void;
  }
>();
let runtime: PersistentQuickJsRuntime | undefined;
let activeExecutionId: string | undefined;
let requestSequence = 0;

port.on('message', (value: unknown) => {
  let message: ParentMessage;
  try {
    message = parseParentMessage(value);
  } catch (error) {
    postFailure(activeExecutionId ?? 'unknown', error, true);
    return;
  }
  void handleMessage(message);
});

async function handleMessage(message: ParentMessage): Promise<void> {
  if (
    message.type === 'provider-response' ||
    message.type === 'provider-error'
  ) {
    const request = pending.get(message.requestId);
    if (!request || request.executionId !== message.executionId) return;
    pending.delete(message.requestId);
    if (message.type === 'provider-response') request.resolve(message.result);
    else
      request.reject(
        Object.assign(new Error(message.error.message), {
          name: message.error.name,
        }),
      );
    return;
  }

  if (message.type === 'initialize') {
    if (runtime) {
      postFailure('initialize', new Error('Worker already initialized'), true);
      return;
    }
    try {
      runtime = await createQuickJsRuntime({
        memoryBytes: TOOLBOX_LIMITS.memoryBytes,
        stackBytes: TOOLBOX_LIMITS.stackBytes,
      });
      post({ type: 'ready' });
    } catch (error) {
      postFailure('initialize', error, true);
    }
    return;
  }

  if (!runtime) {
    postFailure(
      message.executionId,
      new Error('Worker is not initialized'),
      true,
    );
    return;
  }
  if (activeExecutionId) {
    postFailure(message.executionId, new Error('Worker is busy'), true);
    return;
  }

  activeExecutionId = message.executionId;
  try {
    const result = await runtime.execute({
      source: message.source,
      snapshot: message.snapshot,
      deadline: message.deadline,
      maximumOutputBytes: TOOLBOX_LIMITS.maximumOutputBytes,
      request: (request) => requestProvider(message.executionId, request),
    });
    post({ type: 'complete', executionId: message.executionId, result });
  } catch (error) {
    postFailure(message.executionId, error, error instanceof FatalQuickJsError);
  } finally {
    for (const [requestId, request] of pending) {
      if (request.executionId !== message.executionId) continue;
      pending.delete(requestId);
      request.reject(new Error('Execution finished'));
    }
    activeExecutionId = undefined;
  }
}

function requestProvider(
  executionId: string,
  request: ProviderRequest,
): Promise<JsonValue> {
  if (activeExecutionId !== executionId)
    return Promise.reject(new Error('Execution is not active'));
  const requestId = String(++requestSequence);
  return new Promise((resolve, reject) => {
    pending.set(requestId, { executionId, resolve, reject });
    post({
      type: 'provider-request',
      executionId,
      requestId,
      request,
    });
  });
}

function postFailure(
  executionId: string,
  error: unknown,
  fatal: boolean,
): void {
  post({
    type: 'failure',
    executionId,
    error: toSerializedError(error),
    fatal,
  });
}

function post(message: WorkerMessage): void {
  port.postMessage(message);
}

process.once('exit', () => runtime?.dispose());

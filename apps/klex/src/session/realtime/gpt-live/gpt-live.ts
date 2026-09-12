import type { GPTLiveFunctionCall, GPTLiveServerEvent } from './wire-events';

export interface GPTLiveResponseState {
  readonly delegationId: string;
  readonly responseId: string;
  readonly offsetMs: number;
  readonly status: 'active' | 'completed' | 'failed';
  readonly calls: readonly GPTLiveFunctionCall[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface GPTLiveProtocolStateOptions {
  readonly maxResponses?: number;
  readonly maxCallsPerResponse?: number;
}

export interface GPTLiveProtocolState {
  apply(event: GPTLiveServerEvent): void;
  response(responseId: string): GPTLiveResponseState | undefined;
}

interface MutableResponseState {
  readonly delegationId: string;
  responseId: string;
  readonly offsetMs: number;
  status: 'active' | 'completed' | 'failed';
  readonly calls: Map<string, GPTLiveFunctionCall>;
  inputTokens?: number;
  outputTokens?: number;
}

class GPTLiveProtocolStateModule implements GPTLiveProtocolState {
  private readonly responses = new Map<string, MutableResponseState>();
  private readonly delegationResponses = new Map<string, string>();
  private readonly maxResponses: number;
  private readonly maxCallsPerResponse: number;

  constructor(options: GPTLiveProtocolStateOptions) {
    this.maxResponses = positiveInteger(
      options.maxResponses ?? 32,
      'maxResponses',
    );
    this.maxCallsPerResponse = positiveInteger(
      options.maxCallsPerResponse ?? 128,
      'maxCallsPerResponse',
    );
  }

  apply(event: GPTLiveServerEvent): void {
    switch (event.type) {
      case 'delegation-created':
        this.addDelegation(event);
        break;
      case 'response-started':
        this.bindResponse(event.delegationId, event.responseId);
        break;
      case 'response-function-call':
        this.addCall(event.delegationId, event.call);
        break;
      case 'response-terminal':
        this.finishResponse(event);
        break;
      case 'response-error': {
        const response = this.responseForDelegation(event.delegationId);
        if (response.status === 'active') response.status = 'failed';
        break;
      }
      default:
        break;
    }
  }

  response(responseId: string): GPTLiveResponseState | undefined {
    const state = this.responses.get(responseId);
    if (state === undefined) return undefined;
    return Object.freeze({
      delegationId: state.delegationId,
      responseId: state.responseId,
      offsetMs: state.offsetMs,
      status: state.status,
      calls: Object.freeze([...state.calls.values()]),
      ...withKey('inputTokens', state.inputTokens),
      ...withKey('outputTokens', state.outputTokens),
    });
  }

  private addDelegation(
    event: Extract<GPTLiveServerEvent, { type: 'delegation-created' }>,
  ): void {
    const responseForDelegation = this.delegationResponses.get(
      event.delegationId,
    );
    if (
      responseForDelegation !== undefined &&
      responseForDelegation !== event.responseId
    ) {
      throw new Error('GPT-Live delegation ID changed response association');
    }
    const existing = this.responses.get(event.responseId);
    if (existing !== undefined) {
      if (existing.delegationId !== event.delegationId)
        throw new Error('GPT-Live response ID changed delegation association');
      return;
    }
    if (this.responses.size >= this.maxResponses)
      throw new Error('GPT-Live response state limit exceeded');
    this.delegationResponses.set(event.delegationId, event.responseId);
    this.responses.set(event.responseId, {
      delegationId: event.delegationId,
      responseId: event.responseId,
      offsetMs: event.offsetMs,
      status: 'active',
      calls: new Map(),
    });
  }

  private bindResponse(delegationId: string, responseId: string): void {
    const state = this.responseForDelegation(delegationId);
    if (state.responseId === responseId) return;
    const existing = this.responses.get(responseId);
    if (existing !== undefined && existing !== state)
      throw new Error('GPT-Live response ID changed delegation association');
    this.responses.delete(state.responseId);
    state.responseId = responseId;
    this.delegationResponses.set(delegationId, responseId);
    this.responses.set(responseId, state);
  }

  private addCall(delegationId: string, call: GPTLiveFunctionCall): void {
    const state = this.responseForDelegation(delegationId);
    const existing = state.calls.get(call.callId);
    if (existing !== undefined) {
      if (!sameCall(existing, call))
        throw new Error('GPT-Live function call ID changed payload');
      return;
    }
    if (state.calls.size >= this.maxCallsPerResponse)
      throw new Error('GPT-Live function call state limit exceeded');
    state.calls.set(call.callId, Object.freeze({ ...call }));
  }

  private finishResponse(
    event: Extract<GPTLiveServerEvent, { type: 'response-terminal' }>,
  ): void {
    const state = this.responseForDelegation(event.delegationId);
    if (state.responseId !== event.responseId)
      throw new Error(
        'GPT-Live terminal response ID does not match delegation',
      );
    if (state.status !== 'active' && state.status !== event.status)
      throw new Error('GPT-Live response terminal status changed');
    state.status = event.status;
    state.inputTokens = event.inputTokens;
    state.outputTokens = event.outputTokens;
  }

  private responseForDelegation(delegationId: string): MutableResponseState {
    const responseId = this.delegationResponses.get(delegationId);
    const response =
      responseId === undefined ? undefined : this.responses.get(responseId);
    if (response === undefined)
      throw new Error('GPT-Live event references an unknown delegation');
    return response;
  }
}

export function createGPTLiveProtocolState(
  options: GPTLiveProtocolStateOptions = {},
): GPTLiveProtocolState {
  return new GPTLiveProtocolStateModule(options);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function sameCall(
  left: GPTLiveFunctionCall,
  right: GPTLiveFunctionCall,
): boolean {
  return (
    left.itemId === right.itemId &&
    left.callId === right.callId &&
    left.name === right.name &&
    left.argumentsJson === right.argumentsJson
  );
}

function withKey<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

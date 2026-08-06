import type { FilePart, ModelMessage, UserContent } from 'ai';
import { vi } from 'vitest';

import type {
  ExtensionDeps,
  ExtensionFactory,
  ResolvedModel,
} from '@/session/chat/extensions/extension-api';

/** Creates mock ExtensionDeps with sensible defaults. Override any field via `overrides`. */
export function makeDeps(overrides?: Partial<ExtensionDeps>): ExtensionDeps {
  return {
    getHistory: vi.fn(() => []),
    insertMessageAfter: vi.fn(() => true),
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    config: {
      getModelSelection: vi.fn(() => []),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {},
      })),
    } as unknown as ExtensionDeps['config'],
    generateText: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ExtensionDeps['logger'],
    logging: {} as unknown as ExtensionDeps['logging'],
    mcp: {} as unknown as ExtensionDeps['mcp'],
    sessionId: 'test-session',
    getDataDir: vi.fn(() => '/tmp/test-ext-data'),
    ...overrides,
  };
}

/** Wraps content in a user message. */
export function makeUserMessage(content: UserContent): ModelMessage {
  return { role: 'user', content };
}

/** Extracts the content array from a transformed user message. */
export function getContent(
  result: ModelMessage[],
  msgIndex: number,
): Array<Record<string, unknown>> {
  const msg = result[msgIndex] as ModelMessage;
  return msg.content as unknown as Array<Record<string, unknown>>;
}

/** Builds a FilePart from a buffer. */
export function makeFilePart(
  buffer: Buffer,
  mediaType: string,
  filename?: string,
): FilePart {
  return {
    type: 'file',
    data: { type: 'data', data: buffer },
    mediaType,
    ...(filename !== undefined && { filename }),
  };
}

/** Extracts the base64 data string from a file part's data field. */
export function extractFileData(
  part: Record<string, unknown> | undefined,
): string {
  const data = part?.data as { data: string } | undefined;
  return data?.data ?? '';
}

/** Builds a successful generateText result. */
export function genSuccess(
  text: string,
  modelId = 'test:model',
): {
  success: true;
  text: string;
  modelId: string;
  usage: Record<string, unknown>;
} {
  return {
    success: true,
    text,
    modelId,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

/** Builds a failed generateText result. */
export function genFailure(): {
  success: false;
  failureReason: 'all-models-failed';
} {
  return { success: false, failureReason: 'all-models-failed' };
}

/** Runs the contextTransformer of an extension factory and returns the resulting history. */
export async function runTransformer(
  history: ModelMessage[],
  model: ResolvedModel,
  factory: ExtensionFactory,
  deps?: ExtensionDeps,
): Promise<ModelMessage[]> {
  const ext = factory.create(deps ?? makeDeps());
  const result = await ext.contextTransformer?.(history, model);
  return Array.isArray(result)
    ? result
    : (result as { history: ModelMessage[] }).history;
}

/** Builds a ResolvedModel with the given input capabilities and overrides. */
export function makeModel(
  inputCapabilities: Record<string, unknown>,
  overrides?: Partial<ResolvedModel>,
): ResolvedModel {
  return {
    modelId: 'test:model',
    displayName: 'Test Model',
    contextSize: 128_000,
    inputCapabilities: inputCapabilities as ResolvedModel['inputCapabilities'],
    ...overrides,
  };
}

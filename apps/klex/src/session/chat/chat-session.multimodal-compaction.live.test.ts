import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import {
  type Config,
  klexConfigSchema,
  type ModelPurpose,
  type ModelSelectionEntry,
} from '@/config';
import type { IntrospectionScope } from '@/introspection';
import { createLocalData } from '@/local-data';
import {
  builtInProviderDefinitions,
  createProviderRegistry,
} from '@/provider-registry';
import { KLEX_VERSION } from '@/release';
import {
  createSessionHistory,
  SESSION_HISTORY_STORE_DEFINITION,
  type SessionHistory,
  type SessionHistoryRecorder,
} from '@/session-history';

import { createChatSession } from './chat-session';
import { isCheckpointHeader } from './checkpoint';
import { clearAudioInputOptimizerCache } from './extensions/audio-input-optimizer/audio-processing';
import { collectMedia } from './extensions/content-adaptation/media-projection';
import {
  createContextCompactionExt,
  selectCheckpointAnchor,
} from './extensions/context-compaction/context-compaction';
import {
  type Extension,
  type ExtensionFactory,
  type GenerateTextArgs,
  isDataPartOf,
  type StepCompleteEvent,
} from './extensions/extension-api';
import type { ExtendedUIMessage } from './message-types';
import { convertToModelMessagesExtended } from './utils/convert-to-model-messages';
import { LINES_FORMAT_PROMPT } from './utils/history-view';

// Opt-in only. No agent boot, live MCP, scheduled work, telemetry exporter, or tools.
// Set KLEX_COMPACTION_E2E=1, KLEX_COMPACTION_CONFIG (read-only provider config),
// and KLEX_COMPACTION_FIXTURE (private exported cases, media and review/rubric.json).
// Live phases make paid provider calls and send fixture content to OpenAI.
// Generated evidence stays under the private fixture's results directory.
const enabled = process.env.KLEX_COMPACTION_E2E === '1';
const phase = process.env.KLEX_COMPACTION_PHASE ?? 'all';
const fixture = resolve(
  process.env.KLEX_COMPACTION_FIXTURE ?? '../../../compaction-e2e-fixture',
);
const cases = ['audio-01', 'audio-02', 'image-01'] as const;
type Case = (typeof cases)[number];
type Mode = 'configured' | 'native' | 'text-only';
type Fault =
  | 'none'
  | 'transport'
  | 'cancel'
  | 'helper'
  | 'persist'
  | 'refusal-once'
  | 'refusal-always';
const injectedRefusal =
  'Sorry, I can’t help with identifying or analyzing who’s speaking in an audio clip.';
type Fact = { fact: string; pattern: string };
interface State {
  messages: ExtendedUIMessage[];
  instanceId: string;
  idleCheckpointApply: Promise<void> | null;
  transcriptRecorder: SessionHistoryRecorder;
  flushPendingImmediate(): void;
}
interface Call {
  models: string[];
  input: unknown;
  result?: unknown;
}
let provider: ReturnType<typeof klexConfigSchema.parse>['providers']['openai'];
let rubric: Record<Case, Fact[]>;
let runDirectory: string;
const cleanups: Array<() => Promise<void>> = [];
const quiet = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};
const logging = { child: () => quiet } as unknown as RootLogger;
const originalFetch = globalThis.fetch;

function scope(path: string[] = []): IntrospectionScope {
  return {
    path,
    introspect: vi.fn(),
    child: (id) => scope([...path, id]),
    removeChild: vi.fn(),
  };
}
function text(role: 'user' | 'assistant', value: string): ExtendedUIMessage {
  return { id: randomUUID(), role, parts: [{ type: 'text', text: value }] };
}
async function load(id: Case): Promise<ExtendedUIMessage[]> {
  return JSON.parse(
    await readFile(join(fixture, 'cases', id, 'messages.json'), 'utf8'),
  );
}
async function media(id: Case): Promise<ExtendedUIMessage> {
  // Original inline media and message ID; remove captions, metadata, previous
  // replies and tool results so only bytes can reveal the expected facts.
  const [target] = JSON.parse(
    await readFile(join(fixture, 'cases', id, 'media-message.json'), 'utf8'),
  );
  const content = target.parts[0].data.content.filter(
    (part: { type: string }) => part.type !== 'text',
  );
  expect(content.length).toBeGreaterThan(0);
  return {
    id: target.id,
    role: 'user',
    parts: [
      {
        type: 'data-context',
        data: { sourceEnv: 'fixture', metadata: {}, content },
      },
    ],
  } as ExtendedUIMessage;
}
function controlled(target: ExtendedUIMessage): ExtendedUIMessage[] {
  return [
    text('user', 'Earlier history follows.'),
    target,
    text('assistant', 'Attachment received.'),
    text('user', 'New unrelated request: wait for my next input.'),
    text('assistant', 'Waiting.'),
  ];
}
function score(id: Case, summary: string) {
  return rubric[id].map((fact) => ({
    fact: fact.fact,
    present: new RegExp(fact.pattern, 'i').test(summary),
  }));
}
function event(tokens = 1001): StepCompleteEvent {
  return {
    shouldContinue: false,
    forceNextStep: false,
    fatalError: false,
    fatalErrorReason: null,
    generationFailed: false,
    generation: {
      modelId: 'fixture-trigger',
      finishReason: 'stop',
      usage: {
        inputTokens: tokens,
        outputTokens: 1,
        totalTokens: tokens + 1,
        inputTokenDetails: {
          noCacheTokens: tokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
      },
    },
    toolCalls: [],
    modelFallbackOccurred: false,
    requestRejected: false,
  };
}

beforeAll(async () => {
  if (!enabled) return;
  // The only live-agent read. Never persist, log, migrate, or boot this config.
  const configPath = process.env.KLEX_COMPACTION_CONFIG;
  if (!configPath)
    throw new Error('Live replay requires an explicit KLEX_COMPACTION_CONFIG');
  const source = JSON.parse(await readFile(configPath, 'utf8'));
  provider = source.providers.openai;
  expect(provider?.settings.baseUrl).toBe('https://api.openai.com/v1');
  rubric = JSON.parse(
    await readFile(join(fixture, 'review/rubric.json'), 'utf8'),
  );
  await mkdir(join(fixture, 'results'), { recursive: true, mode: 0o700 });
  runDirectory = await mkdtemp(join(fixture, 'results/live-'));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearAudioInputOptimizerCache();
});

async function replay(
  name: string,
  messages: ExtendedUIMessage[],
  mode: Mode,
  fault: Fault = 'none',
) {
  const directory = await mkdtemp(join(runDirectory, `${name}-`));
  const calls: Call[] = [];
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      );
      if (url.origin !== 'https://api.openai.com') {
        requests.push({ blockedHost: url.hostname });
        throw new Error('Fixture network policy: external media fetch blocked');
      }
      let types: string[] = [];
      if (typeof init?.body === 'string') {
        types = [...init.body.matchAll(/"type"\s*:\s*"([^"\n]+)"/g)].map(
          (match) => match[1] ?? '',
        );
      }
      requests.push({
        path: url.pathname,
        types,
        injectedFailure: fault === 'transport' || fault === 'helper',
      });
      if (fault === 'transport' || fault === 'helper')
        return new Response(
          JSON.stringify({
            error: {
              message: 'Injected provider outage',
              type: 'server_error',
            },
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      return originalFetch(input, init);
    },
  );
  const summaryId =
    mode === 'native' && name.startsWith('audio')
      ? 'gpt-audio-1.5'
      : 'gpt-6-luna';
  const reference: ModelSelectionEntry = {
    providerId: mode === 'text-only' ? 'compactor-text-only' : 'openai',
    modelId: summaryId,
  };
  const parsed = klexConfigSchema.parse({
    providers: { openai: provider, 'compactor-text-only': provider },
    modelSelection: {
      // Audio-only models reject text-only helper output. Native-audio recovery
      // also needs a configured text-capable alternate, not the same model.
      chat:
        mode === 'native'
          ? [{ providerId: 'openai', modelId: 'gpt-6-luna' }]
          : [reference],
      compaction: [reference],
      imageVision: [{ providerId: 'openai', modelId: 'gpt-6-luna' }],
      audioListening: [{ providerId: 'openai', modelId: 'gpt-audio-1.5' }],
    },
  });
  const config = {
    get: () => parsed,
    getRuntime: () => parsed,
    subscribe: () => () => {},
    getModelSelection: (purpose: ModelPurpose) =>
      parsed.modelSelection[purpose],
    resolveModel: (entry: ModelSelectionEntry) => ({
      providerId: entry.providerId,
      providerType: 'openai',
      modelId: entry.modelId,
      settings: provider.settings,
      contextSize: 128_000,
      capabilities: {},
      inputCapabilities: {},
      providerOptions: entry.providerOptions,
    }),
  } as unknown as Config;
  const registry = createProviderRegistry({
    logging,
    config,
    definitions: builtInProviderDefinitions,
  });
  await registry.start();
  cleanups.push(() => registry.close());
  const modelResolver = {
    getLanguageModel: registry.getLanguageModel.bind(registry),
    resolveModel: registry.resolveModel.bind(registry),
    resolveInstinctCandidates:
      registry.resolveInstinctCandidates.bind(registry),
    resolveModelInfo: (entry: ModelSelectionEntry) => ({
      ...registry.resolveModelInfo(entry),
      // Trigger deterministically without buying a 100k-token main-model turn.
      // Native decoding, SDK routing, generation and persistence remain real.
      contextSize: 2000,
      ...(entry.providerId === 'compactor-text-only' && {
        inputCapabilities: {},
      }),
    }),
  };
  async function openHistory(): Promise<SessionHistory> {
    await createLocalData({
      logging,
      dataDirectory: directory,
      klexVersion: KLEX_VERSION,
      stores: [SESSION_HISTORY_STORE_DEFINITION],
    }).start();
    const history = createSessionHistory({
      logging,
      config,
      dataDirectory: directory,
    });
    await history.start();
    cleanups.push(() => history.close());
    return history;
  }
  let compactor: Extension | undefined;
  const factory: ExtensionFactory = {
    identifier: createContextCompactionExt.identifier,
    create: (deps) => {
      compactor = createContextCompactionExt.create({
        ...deps,
        generateText: async (args: GenerateTextArgs) => {
          const call: Call = {
            models: args.modelIds.map(
              (entry) => `${entry.providerId}:${entry.modelId}`,
            ),
            input: {
              system: args.system,
              prompt: args.prompt,
              messages: args.messages,
            },
          };
          calls.push(call);
          const controller = new AbortController();
          if (fault === 'cancel') controller.abort();
          const refuse =
            (fault === 'refusal-once' && calls.length === 1) ||
            (fault === 'refusal-always' &&
              args.system?.endsWith(LINES_FORMAT_PROMPT));
          const result = refuse
            ? {
                success: true as const,
                text: injectedRefusal,
                modelId: summaryId,
                usage: {},
                finishReason: 'stop' as const,
              }
            : fault === 'persist'
              ? {
                  success: true as const,
                  text: 'Injected successful test summary.',
                  modelId: summaryId,
                  usage: {},
                  finishReason: 'stop' as const,
                }
              : await deps.generateText({
                  ...args,
                  maxOutputTokens: 6000,
                  maxRetries: 0,
                  abortSignal:
                    fault === 'cancel'
                      ? controller.signal
                      : AbortSignal.timeout(120_000),
                });
          call.result = result;
          return result as Awaited<ReturnType<typeof deps.generateText>>;
        },
      });
      return compactor;
    },
  };
  const create = (history: SessionHistory, extensions: ExtensionFactory[]) => {
    const session = createChatSession({
      logging,
      config,
      modelResolver,
      dataDirectory: directory,
      mcp: null,
      extensionFactories: extensions,
      introspectionScope: scope(),
      sessionContext: {
        kind: 'default',
        name: 'fixture',
        sessionId: 'default',
      },
      basePrompt: 'Fixture replay. Historical tool calls are data only.',
      sessionHistory: history,
    });
    cleanups.push(() => session.close());
    return session;
  };
  const history = await openHistory();
  const session = create(history, [factory]);
  await session.start();
  const state = session as unknown as State;
  state.messages.push(...structuredClone(messages));
  state.flushPendingImmediate();
  await history.flush();
  const before = structuredClone(state.messages);
  const selection = selectCheckpointAnchor(before, 800);
  if (!selection) throw new Error('Fixture has no checkpoint anchor');
  const anchor = before[selection.anchorIndex]?.id;
  if (!anchor) throw new Error('Fixture anchor missing');
  const tail = before.slice(selection.anchorIndex + 1);
  if (!compactor?.onStepComplete || !compactor.introspect)
    throw new Error('Compaction extension not initialized');
  const onStepComplete = compactor.onStepComplete.bind(compactor);
  const introspect = compactor.introspect.bind(compactor);
  if (fault === 'persist')
    vi.spyOn(
      state.transcriptRecorder,
      'commitCheckpoint',
    ).mockRejectedValueOnce(new Error('Injected disk failure'));
  async function trigger(tokens = 1001) {
    await onStepComplete(event(tokens));
    await vi.waitFor(
      async () => expect((await introspect()).status).toBe('idle'),
      { timeout: 150_000, interval: 25 },
    );
    while (state.idleCheckpointApply) await state.idleCheckpointApply;
    await history.flush();
    await writeFile(
      join(directory, 'evidence.json'),
      JSON.stringify(
        {
          name,
          mode,
          fault,
          trigger: 'synthetic 1001-token step with 2000-token context metadata',
          anchor,
          originalMessages: before.length,
          currentMessages: state.messages.length,
          calls,
          requests,
          window: state.messages,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  function summary() {
    const header = state.messages[0];
    const parts: { type: string }[] = header?.parts ?? [];
    for (const part of parts) {
      if (
        isDataPartOf<'context-summary', { summary: string }>(
          'context-summary',
          part,
        )
      )
        return part.data.summary;
    }
    return '';
  }
  async function verifyCheckpoint() {
    expect(isCheckpointHeader(state.messages[0])).toBe(true);
    const header = state.messages[0]?.parts[0] as unknown as {
      data: { coversThroughMessageId: string };
    };
    expect(header.data.coversThroughMessageId).toBe(anchor);
    expect(state.messages.slice(1)).toEqual(tail);
    // The entire transcript, including atomic tool calls/results, remains logged.
    const persisted = await history.getMessages(state.instanceId, {
      limit: 1000,
    });
    expect(
      persisted?.messages
        .filter((entry) => entry.message.id !== state.messages[0]?.id)
        .map((entry) => entry.message),
    ).toEqual(before);
    const window = structuredClone(state.messages);
    await session.close();
    await history.close();
    // Reopen SQLite and create a fresh ChatSession, not just an in-memory read.
    const reopened = await openHistory();
    const restored = create(reopened, []);
    await restored.start();
    expect(restored.getMessages()).toEqual(window);
    return window;
  }
  async function verifyNoCheckpoint() {
    expect(state.messages).toEqual(before);
    expect(summary()).toBe('');
    await session.close();
    await history.close();
    const reopened = await openHistory();
    const restored = create(reopened, []);
    await restored.start();
    expect(restored.getMessages()).toEqual(before);
    const window = await reopened.loadWindow('default', {
      fallbackMaxBytes: 10_000_000,
    });
    expect(window.hasCheckpoint).toBe(false);
  }
  return {
    trigger,
    verifyCheckpoint,
    verifyNoCheckpoint,
    state,
    before,
    summary,
    calls,
    requests,
    history,
    directory,
    compactor,
  };
}

function section(name: string) {
  return enabled && (phase === 'all' || phase === name)
    ? describe.sequential
    : describe.skip;
}
section('raw')('unmodified local history replay', () => {
  for (const id of cases)
    it(`${id}: real compaction, durable checkpoint and restart`, async () => {
      const run = await replay(`${id}-original`, await load(id), 'configured');
      await run.trigger();
      await writeFile(
        join(run.directory, 'fact-score.json'),
        JSON.stringify(score(id, run.summary()), null, 2),
        { mode: 0o600 },
      );
      await run.verifyCheckpoint();
    }, 180_000);
});
section('controlled')('media-only causal controls', () => {
  for (const id of cases) {
    for (const mode of ['native', 'text-only'] as const)
      it(`${id}: ${mode} preserves media-only facts`, async () => {
        const run = await replay(
          `${id}-${mode}`,
          controlled(await media(id)),
          mode,
        );
        await run.trigger();
        const facts = score(id, run.summary());
        await writeFile(
          join(run.directory, 'fact-score.json'),
          JSON.stringify(facts, null, 2),
          { mode: 0o600 },
        );
        expect(facts.every((fact) => fact.present)).toBe(true);
        const input = JSON.stringify(run.calls.at(-1)?.input);
        if (mode === 'text-only') {
          expect(input).toContain('<derived-content');
          expect(run.calls.length).toBeGreaterThan(1);
        }
        expect(
          run.requests.some(
            (request) =>
              Array.isArray(request.types) &&
              request.types.some((type: string) =>
                ['input_audio', 'input_image', 'image_url'].includes(type),
              ),
          ),
        ).toBe(true);
        await run.verifyCheckpoint();
      }, 180_000);
    it(`${id}: matched media-removed control cannot recover facts`, async () => {
      const target = await media(id);
      target.parts = [{ type: 'text', text: 'An attachment was omitted.' }];
      const run = await replay(
        `${id}-no-media`,
        controlled(target),
        'configured',
      );
      await run.trigger();
      expect(score(id, run.summary()).every((fact) => !fact.present)).toBe(
        true,
      );
      await run.verifyCheckpoint();
    }, 180_000);
  }
});
section('representations')(
  'real image through additional UI/SDK/MCP representations',
  () => {
    for (const representation of [
      'user-file',
      'assistant-file',
      'mcp-image',
      'sdk-image',
    ] as const)
      it(representation, async () => {
        const bytes = await readFile(join(fixture, 'media/image-01.png'));
        const url = `data:image/png;base64,${bytes.toString('base64')}`;
        let target: ExtendedUIMessage;
        if (representation.endsWith('file'))
          target = {
            id: randomUUID(),
            role: representation === 'user-file' ? 'user' : 'assistant',
            parts: [{ type: 'file', mediaType: 'image/png', url }],
          };
        else
          target = {
            id: randomUUID(),
            role: 'assistant',
            parts: [
              {
                type: 'tool-fixture',
                toolCallId: randomUUID(),
                state: 'output-available',
                input: {},
                output:
                  representation === 'mcp-image'
                    ? {
                        content: [
                          {
                            type: 'image',
                            mimeType: 'image/png',
                            data: bytes.toString('base64'),
                          },
                        ],
                      }
                    : {
                        type: 'content',
                        value: [
                          {
                            type: 'image-data',
                            mediaType: 'image/png',
                            data: bytes.toString('base64'),
                          },
                        ],
                      },
              },
            ],
          } as unknown as ExtendedUIMessage;
        const run = await replay(
          `image-01-${representation}`,
          controlled(target),
          'native',
        );
        await run.trigger();
        await run.verifyCheckpoint();
        expect(
          run.requests.some(
            (request) =>
              Array.isArray(request.types) &&
              request.types.includes('input_image'),
          ),
          'Tool/attachment image must reach the provider, not just the transcript placeholder',
        ).toBe(true);
        expect(
          score('image-01', run.summary()).every((fact) => fact.present),
        ).toBe(true);
      }, 180_000);
  },
);
section('failures')(
  'failure safety with actual decoders, SDK and checkpoint persistence',
  () => {
    for (const fault of ['transport', 'cancel', 'helper', 'persist'] as const)
      it(`${fault}: no successful durable checkpoint means no trim`, async () => {
        const run = await replay(
          `audio-01-${fault}`,
          controlled(await media('audio-01')),
          fault === 'helper' ? 'text-only' : 'native',
          fault,
        );
        await run.trigger();
        expect(run.state.messages).toEqual(run.before);
        const restored = await run.history.loadWindow('default', {
          fallbackMaxBytes: 10_000_000,
        });
        expect(restored.hasCheckpoint).toBe(false);
        expect(restored.entries.map((entry) => entry.message)).toEqual(
          run.before,
        );
        if (fault === 'cancel') expect(run.requests).toHaveLength(0);
        if (fault === 'transport')
          expect(run.requests.length).toBeGreaterThanOrEqual(2);
      }, 180_000);
    it('unreadable audio aborts compaction before any provider call', async () => {
      const target: ExtendedUIMessage = {
        id: randomUUID(),
        role: 'user',
        parts: [
          {
            type: 'file',
            mediaType: 'audio/mp4',
            url: 'data:audio/mp4;base64,bm90LWF1ZGlv',
          },
        ],
      };
      const run = await replay(
        'audio-01-corrupt',
        controlled(target),
        'native',
      );
      await run.trigger();
      expect(run.state.messages).toEqual(run.before);
      expect(run.requests).toHaveLength(0);
    }, 180_000);
  },
);
section('refusal')('ordinary-success refusal checkpoint safety', () => {
  it('rejects the observed refusal, then compacts via helper and text-model fallback and restores', async () => {
    const run = await replay(
      'audio-01-refusal-once',
      controlled(await media('audio-01')),
      'native',
      'refusal-once',
    );
    await run.trigger();
    expect(run.calls[0]?.result).toMatchObject({
      success: true,
      text: injectedRefusal,
      finishReason: 'stop',
    });
    expect(run.calls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(run.calls.at(-1)?.input)).toContain(
      '<derived-content',
    );
    expect(run.summary()).not.toContain(injectedRefusal);
    await run.verifyCheckpoint();
    expect(score('audio-01', run.summary()).every((fact) => fact.present)).toBe(
      true,
    );
    expect(
      run.requests.some(
        (request) =>
          Array.isArray(request.types) && request.types.includes('input_audio'),
      ),
    ).toBe(true);
  }, 180_000);

  it('never persists a checkpoint when all summaries are successful refusals', async () => {
    const run = await replay(
      'audio-01-refusal-always',
      controlled(await media('audio-01')),
      'native',
      'refusal-always',
    );
    await run.trigger();
    expect(run.calls[0]?.result).toMatchObject({
      success: true,
      text: injectedRefusal,
    });
    expect(run.calls.length).toBeLessThanOrEqual(5);
    await run.verifyNoCheckpoint();
  }, 180_000);
});

section('projection')(
  'deterministic SDK UI-output regression (no provider call)',
  () => {
    it('collects SDK content wrapped by the actual UI-to-model converter', async () => {
      const bytes = await readFile(join(fixture, 'media/image-01.png'));
      const ui: ExtendedUIMessage = {
        id: randomUUID(),
        role: 'assistant',
        parts: [
          {
            type: 'tool-fixture',
            toolCallId: randomUUID(),
            state: 'output-available',
            input: {},
            output: {
              type: 'content',
              value: [
                {
                  type: 'image-data',
                  mediaType: 'image/png',
                  data: bytes.toString('base64'),
                },
              ],
            },
          },
        ],
      } as unknown as ExtendedUIMessage;
      const converted = await convertToModelMessagesExtended([ui], {});
      expect(converted.some((message) => message.role === 'tool')).toBe(true);
      expect(collectMedia(converted)).toHaveLength(1);
    });
  },
);
section('stability')('native audio semantic stability', () => {
  for (let attempt = 1; attempt <= 5; attempt++)
    it(`audio-01: native repeat ${attempt}`, async () => {
      const run = await replay(
        `audio-01-native-repeat-${attempt}`,
        controlled(await media('audio-01')),
        'native',
      );
      await run.trigger();
      const facts = score('audio-01', run.summary());
      await writeFile(
        join(run.directory, 'fact-score.json'),
        JSON.stringify(facts, null, 2),
        { mode: 0o600 },
      );
      await run.verifyCheckpoint();
      expect(facts.every((fact) => fact.present)).toBe(true);
    }, 180_000);
});
section('repeat')('repeated compaction', () => {
  it('preserves earlier audio facts alongside a later image and restores', async () => {
    const run = await replay(
      'audio-01-repeat',
      controlled(await media('audio-01')),
      'configured',
    );
    await run.trigger();
    expect(score('audio-01', run.summary()).every((fact) => fact.present)).toBe(
      true,
    );
    await run.trigger(100); // Establish post-checkpoint hysteresis baseline.
    run.state.messages.push(...controlled(await media('image-01')));
    run.state.flushPendingImmediate();
    await run.trigger();
    expect(score('audio-01', run.summary()).every((fact) => fact.present)).toBe(
      true,
    );
    expect(score('image-01', run.summary()).every((fact) => fact.present)).toBe(
      true,
    );
    const current = structuredClone(run.state.messages);
    await run.history.flush();
    const restored = await run.history.loadWindow('default', {
      fallbackMaxBytes: 10_000_000,
    });
    expect(restored.entries.map((entry) => entry.message)).toEqual(current);
  }, 360_000);
});

import type { Span } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '@/config';
import { defaultInstinctConfig } from '@/config/config.test-fixtures';
import type { IntrospectionScope } from '@/introspection';
import { createExtensionHandler } from '@/session/chat/extension-handler';
import type {
  BaseExtensionDeps,
  Extension,
  ExtensionFactory,
  InstinctContext,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { testLogger } from '@/session/chat/test-helpers';
import { tracer } from '@/session/chat/utils/tracing';

import type { InstinctStructuredGenerator } from './classifier';
import { createInstinctRunner } from './instinct';

const request = {
  prompt: 'Decide.',
  keys: { needed: { type: 'boolean' as const, description: 'Needed?' } },
};
const message: ExtendedUIMessage = {
  id: 'input',
  role: 'user',
  parts: [{ type: 'text', text: 'Remember the task' }],
};
const scope = (): IntrospectionScope => ({
  path: [],
  child: () => scope(),
  introspect: vi.fn(),
  removeChild: vi.fn(),
});
const part: ExtendedUIMessage['parts'][number] = {
  type: 'data-check',
  data: {},
};

function harness(
  extensions: Record<string, Extension>,
  generate: InstinctStructuredGenerator = async () => ({
    status: 'ok',
    output: { first: { needed: true }, second: { needed: false } },
    modelId: 'classifier',
  }),
  limits = {},
) {
  const extensionHandler = createExtensionHandler({
    factories: Object.entries(extensions).map(
      ([identifier, extension]): ExtensionFactory => ({
        identifier,
        create: () => extension,
      }),
    ),
    extensionDeps: {
      logger: testLogger,
      logging: { child: () => testLogger },
      config: {} as Config,
      getHistory: () => [],
      generateText: vi.fn(),
      sessionId: 'test',
      sessionContext: { kind: 'default', name: 'main', sessionId: 'test' },
    } as unknown as BaseExtensionDeps,
    dataDirectory: '/tmp/instinct-test',
    sessionId: 'test',
    introspectionScope: scope(),
  });
  const runner = createInstinctRunner({
    logger: testLogger,
    extensionHandler,
    generate,
    getConfig: () => ({ ...defaultInstinctConfig, ...limits }),
  });
  return {
    runner,
    extensionHandler,
    run: (signal = new AbortController().signal) =>
      runner.run({ history: [message], signal }),
  };
}

describe('InstinctRunner', () => {
  it('makes one shared call, isolates contexts, stages in factory order and commits once', async () => {
    const contexts: InstinctContext[] = [];
    const generate = vi.fn<InstinctStructuredGenerator>().mockResolvedValue({
      status: 'ok',
      modelId: 'classifier',
      output: { first: { needed: true }, second: { needed: false } },
    });
    const first: Extension = {
      getInstinctClassificationRequest: () => request,
      dataPartTransformers: { check: () => [] },
      onInstinct: (ctx) => {
        contexts.push(ctx);
        ctx.history[0]!.parts = [];
        ctx.prepare.appendPersistent([part]);
        ctx.prepare.appendProvisional([{ type: 'text', text: 'provisional' }]);
        ctx.prepare.appendEphemeral([{ type: 'text', text: 'ephemeral' }]);
      },
    };
    const second: Extension = {
      getInstinctClassificationRequest: () => request,
      onInstinct: (ctx) => {
        contexts.push(ctx);
      },
    };
    const { run } = harness({ first, second }, generate);
    const result = await run();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('not ready');
    expect(generate).toHaveBeenCalledOnce();
    expect(contexts[1]?.history[0]?.parts).toEqual(message.parts);
    expect(contexts.map((ctx) => ctx.classification)).toEqual([
      { status: 'ok', modelId: 'classifier', answers: { needed: true } },
      { status: 'ok', modelId: 'classifier', answers: { needed: false } },
    ]);
    expect(result.persistent.map((entry) => entry.extensionIdentifier)).toEqual(
      ['first'],
    );
    expect(result.provisional).toEqual([{ type: 'text', text: 'provisional' }]);
    expect(result.ephemeral).toEqual([{ type: 'text', text: 'ephemeral' }]);
    const canonical = [structuredClone(message)];
    result.commit(canonical);
    expect(canonical).toHaveLength(2);
    expect(() => result.commit(canonical)).toThrow('already committed');
    expect(() => contexts[0]!.prepare.appendEphemeral([])).toThrow('settled');
    await run();
    expect(contexts.at(-1)?.delta).toMatchObject({ initial: false, added: [] });
  });

  it('rejects another extension’s data type and discards all of the offending reaction', async () => {
    const { run, extensionHandler } = harness({
      first: { dataPartTransformers: { check: () => [] } },
      second: {
        onInstinct: (ctx) => {
          ctx.prepare.appendEphemeral([{ type: 'text', text: 'discard me' }]);
          ctx.prepare.appendPersistent([part]);
        },
      },
    });
    expect(extensionHandler.getOwnedDataPartKeys('first')).toEqual(
      new Set(['check']),
    );
    expect(extensionHandler.getOwnedDataPartKeys('second')).toEqual(new Set());
    const result = await run();
    expect(result).toMatchObject({
      status: 'ready',
      persistent: [],
      ephemeral: [],
      summary: {
        reactions: [{ extensionIdentifier: 'second', status: 'failed' }],
      },
    });
  });

  it.each(['unavailable', 'failed'] as const)(
    'lets reactions recover from %s classification',
    async (status) => {
      let context: InstinctContext | undefined;
      const { run } = harness(
        {
          first: {
            getInstinctClassificationRequest: () => request,
            onInstinct: (ctx) => {
              context = ctx;
              ctx.prepare.appendEphemeral([{ type: 'text', text: 'fallback' }]);
            },
          },
        },
        async () => ({ status, reason: 'test failure' }),
      );
      expect(await run()).toMatchObject({
        status: 'ready',
        ephemeral: [{ type: 'text', text: 'fallback' }],
      });
      expect(context?.classification?.status).toBe(status);
    },
  );

  it('continues with fallback reactions when a data projector throws', async () => {
    const generate = vi.fn<InstinctStructuredGenerator>();
    let context: InstinctContext | undefined;
    const { runner } = harness(
      {
        first: {
          getInstinctClassificationRequest: () => request,
          dataPartTransformers: {
            custom: () => {
              throw new Error('broken projection');
            },
          },
          onInstinct: (ctx) => {
            context = ctx;
            ctx.prepare.appendEphemeral([
              { type: 'text', text: 'fallback context' },
            ]);
          },
        },
      },
      generate,
    );
    const history: ExtendedUIMessage[] = [
      {
        ...message,
        parts: [
          { type: 'data-custom', data: {} },
        ] as unknown as ExtendedUIMessage['parts'],
      },
    ];
    const result = await runner.run({
      history,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: 'ready',
      ephemeral: [{ type: 'text', text: 'fallback context' }],
      summary: { classifierStatus: 'failed', reactions: [{ status: 'ok' }] },
    });
    expect(context?.classification?.status).toBe('failed');
    expect(generate).not.toHaveBeenCalled();
    if (result.status !== 'ready') throw new Error('Not ready');
    result.commit(history);
    expect(history).toHaveLength(1);
  });

  it('reports shared budget expiry as timeout, not caller cancellation', async () => {
    const reaction = vi.fn();
    const { run } = harness(
      {
        first: {
          getInstinctClassificationRequest: () => request,
          onInstinct: reaction,
        },
      },
      () => new Promise(() => {}),
      { timeoutMs: 20, classifierTimeoutMs: 1000 },
    );
    expect(await run()).toMatchObject({
      status: 'ready',
      summary: {
        classifierStatus: 'timeout',
        reactions: [{ status: 'timeout' }],
      },
    });
    expect(reaction).not.toHaveBeenCalled();
  });

  it('ends a timed-out reaction span even if the hook never settles', async () => {
    const spans: { name: string; end: ReturnType<typeof vi.fn> }[] = [];
    const spy = vi.spyOn(tracer, 'startActiveSpan').mockImplementation(((
      name: string,
      ...args: unknown[]
    ) => {
      const end = vi.fn();
      spans.push({ name, end });
      const span = {
        end,
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        recordException: vi.fn(),
      } as unknown as Span;
      return (args.at(-1) as (span: Span) => unknown)(span);
    }) as typeof tracer.startActiveSpan);
    let reject: ((error: Error) => void) | undefined;
    try {
      const { run } = harness(
        {
          first: {
            onInstinct: () =>
              new Promise<void>((_resolve, fail) => {
                reject = fail;
              }),
          },
        },
        undefined,
        { timeoutMs: 20 },
      );
      expect(await run()).toMatchObject({
        status: 'ready',
        summary: { reactions: [{ status: 'timeout' }] },
      });
      expect(
        spans.find(({ name }) => name === 'step.instinct.reaction')?.end,
      ).toHaveBeenCalledOnce();
      reject?.(new Error('late hook failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        spans.find(({ name }) => name === 'step.instinct.reaction')?.end,
      ).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('skips disabled runs and runs without participants or requests', async () => {
    const generate = vi.fn<InstinctStructuredGenerator>();
    expect(await harness({}, generate).run()).toEqual({ status: 'skipped' });
    expect(
      await harness({ first: { onInstinct: () => {} } }, generate, {
        enabled: false,
      }).run(),
    ).toEqual({ status: 'skipped' });
    expect(
      await harness({ first: { onInstinct: () => {} } }, generate).run(),
    ).toMatchObject({
      status: 'ready',
      summary: { classifierStatus: 'skipped' },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('bounds uncooperative classifier and reaction work and seals late writes', async () => {
    let context: InstinctContext | undefined;
    let finish!: () => void;
    const { run } = harness(
      {
        first: {
          getInstinctClassificationRequest: () => request,
          onInstinct: (ctx) => {
            context = ctx;
            ctx.prepare.appendEphemeral([{ type: 'text', text: 'discard' }]);
            return new Promise<void>((resolve) => {
              finish = resolve;
            });
          },
        },
      },
      () => new Promise(() => {}),
      { classifierTimeoutMs: 10, timeoutMs: 40 },
    );
    const result = await run();
    expect(result).toMatchObject({
      status: 'ready',
      ephemeral: [],
      summary: {
        classifierStatus: 'timeout',
        reactions: [{ status: 'timeout' }],
      },
    });
    expect(() => context!.prepare.appendEphemeral([])).toThrow('settled');
    finish();
  });

  it('seals a settled reaction while another extension is still running', async () => {
    let firstContext: InstinctContext | undefined;
    let finish!: () => void;
    const { run } = harness({
      first: {
        onInstinct: (ctx) => {
          firstContext = ctx;
          ctx.prepare.appendEphemeral([{ type: 'text', text: 'kept' }]);
        },
      },
      second: {
        onInstinct: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      },
    });
    const pending = run();
    await vi.waitFor(() =>
      expect(() => firstContext!.prepare.appendEphemeral([])).toThrow(
        'settled',
      ),
    );
    finish();
    expect(await pending).toMatchObject({
      status: 'ready',
      ephemeral: [{ type: 'text', text: 'kept' }],
    });
  });

  it('ignores invalid and throwing registrations without blocking another reaction', async () => {
    const generate = vi.fn<InstinctStructuredGenerator>();
    const reaction = vi.fn();
    const { run } = harness(
      {
        first: {
          getInstinctClassificationRequest: () => ({ prompt: '', keys: {} }),
          onInstinct: reaction,
        },
        second: {
          getInstinctClassificationRequest: () => {
            throw new Error('registration failed');
          },
        },
      },
      generate,
    );
    expect(await run()).toMatchObject({
      status: 'ready',
      summary: { classifierStatus: 'skipped' },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(reaction.mock.calls[0]?.[0].classification).toBeNull();
  });

  it('aborts without committing or losing the history baseline', async () => {
    let context: InstinctContext | undefined;
    const controller = new AbortController();
    const { run } = harness({
      first: {
        onInstinct: (ctx) => {
          context = ctx;
          ctx.prepare.appendEphemeral([{ type: 'text', text: 'discard' }]);
          controller.abort();
        },
      },
    });
    expect(await run(controller.signal)).toMatchObject({ status: 'aborted' });
    expect(() => context!.prepare.appendEphemeral([])).toThrow('settled');
    await run();
    expect(context?.delta).toMatchObject({ initial: true, added: [message] });
  });
});

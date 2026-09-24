import type { ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type z from 'zod';

import type {
  Extension,
  StepCompleteEvent,
} from '@/session/chat/extensions/extension-api';

import {
  DEFAULT_MEMORY_RETRIEVAL_CONFIG,
  type MemoryRetrievalConfig,
} from './retrieval';
import { createRetrievalToolsExt } from './retrieval-tools';
import type { EpisodicSearchIndex } from './search-index';

const finalStep = {
  shouldContinue: false,
  fatalError: false,
} as StepCompleteEvent;

function createHarness(config: Partial<MemoryRetrievalConfig> = {}) {
  const onSurface = vi.fn();
  const index = {
    clearOwner: vi.fn(),
    reconcile: vi.fn(async () => undefined),
    getState: vi.fn(() => ({ status: 'ready' })),
  } as unknown as EpisodicSearchIndex;
  const extension = createRetrievalToolsExt({
    index,
    retrieval: { ...DEFAULT_MEMORY_RETRIEVAL_CONFIG, ...config },
    onSurface,
  }).create({} as never) as Extension;
  const tools = extension.getTools?.({} as never) as ToolSet;
  const surfaceTool = tools.surfaceMemory;
  if (!surfaceTool?.execute) throw new Error('surfaceMemory missing');
  const execute = surfaceTool.execute;
  const schema = surfaceTool.inputSchema as z.ZodType;
  const inspect = tools.inspectMemory?.execute;
  if (!inspect) throw new Error('inspectMemory missing');
  return {
    extension,
    index,
    inspect: () => inspect({}, { toolCallId: 'i', messages: [] } as never),
    onSurface,
    schema,
    surface: (input: Record<string, unknown>) =>
      execute(
        schema.parse(input) as never,
        { toolCallId: 't', messages: [] } as never,
      ),
  };
}

describe('retrieval index freshness', () => {
  it('reconciles the index once per child turn', async () => {
    const { extension, index, inspect } = createHarness();
    extension.onStepStart?.();

    await inspect();
    await inspect();
    expect(index.reconcile).toHaveBeenCalledOnce();

    extension.onStepComplete?.(finalStep);
    extension.onStepStart?.();
    await inspect();
    expect(index.reconcile).toHaveBeenCalledTimes(2);
  });
});

describe('surfaceMemory tool', () => {
  it('passes the parsed memory to onSurface', async () => {
    const { extension, onSurface, surface } = createHarness();
    extension.onStepStart?.();

    await expect(
      surface({ scope: 'whatsapp conversation:c1', memory: ' fact ' }),
    ).resolves.toEqual({ ok: true });

    expect(onSurface).toHaveBeenCalledWith({
      scope: 'whatsapp conversation:c1',
      memory: 'fact',
      followUps: [],
    });
  });

  it('enforces schema limits from config', () => {
    const { schema } = createHarness({
      maxSurfacedMemoryCharacters: 5,
      maxFollowUpsPerMemory: 1,
      maxFollowUpCharacters: 3,
    });

    expect(schema.safeParse({ scope: 'app', memory: 'ok' }).success).toBe(true);
    expect(schema.safeParse({ scope: 'app', memory: '123456' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ scope: 'app', memory: '  ' }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ scope: 'app', memory: 'ok', followUps: ['a', 'b'] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ scope: 'app', memory: 'ok', followUps: ['long'] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ scope: 'bad scope!', memory: 'ok' }).success,
    ).toBe(false);
  });

  it('limits surfaces per child turn and resets on the next turn', async () => {
    const { extension, index, onSurface, surface } = createHarness({
      maxSurfacedMemoriesPerTurn: 1,
    });
    extension.onStepStart?.();

    await surface({ scope: 'app', memory: 'one' });
    await expect(surface({ scope: 'app', memory: 'two' })).resolves.toEqual({
      error: 'surface budget exhausted',
    });
    extension.onStepComplete?.(finalStep);
    expect(index.clearOwner).toHaveBeenCalledOnce();

    extension.onStepStart?.();
    await expect(surface({ scope: 'app', memory: 'three' })).resolves.toEqual({
      ok: true,
    });
    expect(onSurface).toHaveBeenCalledTimes(2);
  });

  it('keeps the budget across continuing steps of one turn', async () => {
    const { extension, index, surface } = createHarness({
      maxSurfacedMemoriesPerTurn: 1,
    });
    extension.onStepStart?.();
    await surface({ scope: 'app', memory: 'one' });
    extension.onStepComplete?.({ ...finalStep, shouldContinue: true });
    extension.onStepStart?.();

    await expect(surface({ scope: 'app', memory: 'two' })).resolves.toEqual({
      error: 'surface budget exhausted',
    });
    expect(index.clearOwner).not.toHaveBeenCalled();
  });
});

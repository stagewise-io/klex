import { describe, expect, it, vi } from 'vitest';

import type {
  ExtensionDeps,
  InstinctContext,
  InstinctInput,
  StepCompleteEvent,
} from '../extension-api';
import { createEffortExt } from './effort';

function fixture(
  mode: 'off' | 'shadow' | 'automatic' = 'shadow',
  instincts: unknown[] = [{}],
) {
  const config = { effort: { mode, floor: 'low', ceiling: 'high' } };
  const getModelSelection = vi.fn(() => instincts);
  const deps = {
    config: { get: () => config, getModelSelection },
    getHistory: () => [],
  } as unknown as ExtensionDeps;
  const ext = createEffortExt.create(deps);
  const setEffort = vi.fn();
  const input: InstinctInput = {
    history: [],
    delta: { messages: [], removedMessageIds: [], changedMessageIds: [] },
  } as unknown as InstinctInput;
  const context = {
    ...input,
    classification: null,
    signal: new AbortController().signal,
    deadline: Date.now() + 1000,
    prepare: { setEffort },
  } as unknown as InstinctContext;
  return { ext, config, input, context, setEffort, getModelSelection };
}

describe('effort extension', () => {
  it('defaults absent configuration to shadow with trace diagnostics', () => {
    const f = fixture();
    Reflect.deleteProperty(f.config, 'effort');
    expect(f.ext.getInstinctClassificationRequest?.(f.input)).not.toBeNull();
    f.ext.onInstinct?.(f.context);
    expect(f.setEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'shadow',
        intent: 'low',
        diagnostics: expect.objectContaining({
          classificationAvailable: false,
        }),
      }),
    );
  });
  it('does nothing when off', () => {
    const off = fixture('off');
    expect(off.ext.getInstinctClassificationRequest?.(off.input)).toBeNull();
    off.ext.onInstinct?.(off.context);
    expect(off.setEffort).not.toHaveBeenCalled();
  });
  it('requests classification without an Instinct model so core can fall back to Chat models', () => {
    const f = fixture('shadow', []);
    expect(
      f.ext.getInstinctClassificationRequest?.(f.input)?.keys,
    ).toHaveProperty('demand');
    expect(f.getModelSelection).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'commits hysteresis only after usable generation (aborted=%s)',
    (aborted) => {
      const f = fixture();
      f.ext.onStepStart?.();
      f.ext.onInstinct?.({
        ...f.context,
        classification: {
          status: 'ok',
          modelId: 'fixture',
          answers: {
            demand: 0,
            failing: true,
            consequential: false,
            missingEvidence: false,
            resolved: false,
            progress: false,
          },
        },
      });
      expect(f.setEffort.mock.lastCall?.[0].intent).toBe('high');
      f.ext.onStepComplete?.({
        instinctAborted: aborted,
        generation: {},
        generationFailed: false,
        requestRejected: false,
      } as StepCompleteEvent);
      f.ext.onStepStart?.();
      f.ext.onInstinct?.(f.context);
      expect(f.setEffort.mock.lastCall?.[0].intent).toBe(
        aborted ? 'low' : 'high',
      );
    },
  );
  it('stages low on missing classification, uses shared rubric, and honors mode changes', () => {
    const f = fixture();
    expect(
      f.ext.getInstinctClassificationRequest?.(f.input)?.keys,
    ).toHaveProperty('missingEvidence');
    f.ext.onInstinct?.(f.context);
    expect(f.setEffort).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: 'low',
        mode: 'shadow',
        reason: 'classifier-unavailable',
        diagnostics: expect.objectContaining({
          classificationAvailable: false,
          desired: 'low',
          previous: 'low',
        }),
      }),
    );
    f.config.effort.mode = 'automatic';
    f.ext.onInstinct?.({
      ...f.context,
      classification: {
        status: 'ok',
        modelId: 'fixture',
        answers: {
          demand: 3,
          failing: false,
          consequential: false,
          missingEvidence: false,
        },
      },
    });
    expect(f.setEffort).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: 'high',
        mode: 'automatic',
        reason: 'hard-next-step',
        diagnostics: expect.objectContaining({
          classificationAvailable: true,
          demand: 3,
        }),
      }),
    );
  });
});

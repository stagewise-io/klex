import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { DEFAULT_SESSION_ID } from '@/session/types';
import { makeDeps } from '@/shared-utilities/test-utils';
import { createSkillRegistry, MAX_PROMPT_LIST_CHARACTERS } from '@/skills';

import type { StepCompleteEvent } from '../extension-api';
import { fairOrder, renderSkillList } from './skill-list';
import { createSkillsExt } from './skills';

const directories: string[] = [];
const logger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
} as unknown as ModuleLogger;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function startedRegistry() {
  const directory = await mkdtemp(join(tmpdir(), 'klex-skills-ext-'));
  directories.push(directory);
  const registry = createSkillRegistry({ dataDirectory: directory, logger });
  await registry.start();
  return registry;
}

function listed(
  namespace: string,
  name: string,
  description = `Does ${name}.`,
  lastReadAt: string | null = null,
) {
  return {
    id: `${namespace}/${name}`,
    namespace,
    name,
    description,
    lastReadAt,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function step(overrides: Partial<StepCompleteEvent> = {}): StepCompleteEvent {
  return {
    shouldContinue: false,
    forceNextStep: false,
    fatalError: false,
    fatalErrorReason: null,
    generationFailed: false,
    generation: {} as StepCompleteEvent['generation'],
    toolCalls: [],
    modelFallbackOccurred: false,
    requestRejected: false,
    ...overrides,
  };
}

type ReadSkillTool = { execute: (input: { id: string }) => Promise<string> };

describe('skill list rendering', () => {
  it('renders nothing without skills', () => {
    expect(renderSkillList([])).toBe('');
  });

  it('alternates namespaces, each most recently used first', () => {
    const ordered = fairOrder([
      listed('alpha', 'old'),
      listed('alpha', 'recent', 'x', '2026-02-01T00:00:00.000Z'),
      listed('alpha', 'third'),
      listed('beta', 'only'),
    ]);
    expect(ordered.map((skill) => skill.id)).toEqual([
      'alpha/recent',
      'beta/only',
      'alpha/old',
      'alpha/third',
    ]);
  });

  it('keeps a small namespace visible next to an oversized one', () => {
    const long = 'x'.repeat(400);
    const skills = [
      ...Array.from({ length: 40 }, (_, index) =>
        listed('big', `skill-${index}`, long),
      ),
      listed('small', 'a'),
      listed('small', 'b'),
    ];
    const rendered = renderSkillList(skills);
    expect(rendered).toContain('- small/a: Does a.');
    expect(rendered).toContain('- small/b: Does b.');
    expect(rendered).toContain(
      '- More skills (read one to see when it applies): ',
    );
    const list = rendered.slice(rendered.indexOf('\n- ') + 1);
    expect(list.length).toBeLessThanOrEqual(MAX_PROMPT_LIST_CHARACTERS);
  });
});

describe('skills extension', () => {
  it('lists skills of every namespace and reads them by id', async () => {
    const registry = await startedRegistry();
    registry.claimNamespace('ext.a', 'alpha');
    registry.claimNamespace('ext.b', 'beta');
    await registry
      .forNamespace('alpha')
      .put('fix-build', { description: 'Fix the build.', body: 'Run it.' });
    await registry
      .forNamespace('beta')
      .put('fix-build', { description: 'Other fix.', body: 'Other.' });
    const ext = createSkillsExt(registry).create(makeDeps());
    await ext.onStart?.();
    const prompt = ext.getSystemPromptPart?.() ?? '';
    expect(prompt).toContain('- alpha/fix-build: Fix the build.');
    expect(prompt).toContain('- beta/fix-build: Other fix.');

    const tool = ext.getTools?.({} as never)
      .readSkill as unknown as ReadSkillTool;
    expect(await tool.execute({ id: 'beta/fix-build' })).toContain('Other.');
    await vi.waitFor(() =>
      expect(registry.get('beta/fix-build')?.readCount).toBe(1),
    );
    expect(registry.get('alpha/fix-build')?.readCount).toBe(0);
  });

  it('suggests ids with a matching bare name first for unknown ids', async () => {
    const registry = await startedRegistry();
    registry.claimNamespace('ext.a', 'alpha');
    await registry
      .forNamespace('alpha')
      .put('aaa', { description: 'A.', body: 'A.' });
    await registry
      .forNamespace('alpha')
      .put('fix-build', { description: 'F.', body: 'F.' });
    const ext = createSkillsExt(registry).create(makeDeps());
    const tool = ext.getTools?.({} as never)
      .readSkill as unknown as ReadSkillTool;
    expect(await tool.execute({ id: 'fix-build' })).toBe(
      'Unknown skill "fix-build". Available: alpha/fix-build, alpha/aaa',
    );
  });

  it('ticks once per successful completed default-session turn', async () => {
    const registry = await startedRegistry();
    const ext = createSkillsExt(registry).create(
      makeDeps({ sessionId: DEFAULT_SESSION_ID }),
    );
    await ext.onStepComplete?.(step({ shouldContinue: true }));
    await ext.onStepComplete?.(step({ forceNextStep: true, generation: null }));
    await ext.onStepComplete?.(step());
    expect(registry.currentTurn()).toBe(1);

    await ext.onStepComplete?.(step({ generation: null }));
    await ext.onStepComplete?.(step({ generationFailed: true }));
    await ext.onStepComplete?.(step({ fatalError: true }));
    expect(registry.currentTurn()).toBe(1);
  });

  it('never ticks outside the default session', async () => {
    const registry = await startedRegistry();
    const ext = createSkillsExt(registry).create(
      makeDeps({ sessionId: 'child-1' }),
    );
    await ext.onStepComplete?.(step());
    expect(registry.currentTurn()).toBe(0);
  });
});

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { createSkillRegistry } from '@/skills';

import { LEARNING_EXTENSION_ID } from './learning';
import { LEARNING_SKILL_NAMESPACE } from './learning-config';
import { createLearningState } from './learning-state';
import { createLearningWorker } from './learning-worker';
import { learningActivities } from './test-activities';
import { type ChildReply, childHarness, reply as ok } from './test-child';

// The real prompt text, so the test sees the sections the model sees.
vi.mock('./extraction-prompt.md', async () => {
  const { readFile: read } = await import('node:fs/promises');
  return {
    default: await read(
      new URL('./extraction-prompt.md', import.meta.url),
      'utf8',
    ),
  };
});
vi.mock('./consolidation-prompt.md', async () => {
  const { readFile: read } = await import('node:fs/promises');
  return {
    default: await read(
      new URL('./consolidation-prompt.md', import.meta.url),
      'utf8',
    ),
  };
});
// Only the episode feed is real; the rest of the memory barrel pulls in the
// whole extension graph and its Markdown imports.
vi.mock('@/session/chat/extensions/memory/memory', () => ({
  createMemoryExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/memory/retrieval', () => ({
  EPISODIC_SEARCH_INDEX_STORE_DEFINITION: {},
}));
vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: '',
}));

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Canonical message id inside an activity id (`history:` + base64url JSON). */
function messageIdOf(activityId: string): string {
  const decoded = JSON.parse(
    Buffer.from(activityId.slice('history:'.length), 'base64url').toString(),
  ) as [number, string, string];
  return decoded[2];
}

function reply(...operations: object[]): ChildReply {
  return ok(JSON.stringify({ operations }));
}

async function harness() {
  const fixture = await learningActivities();
  cleanup.push(() => fixture.close());
  const root = fixture.directory;
  const episodes = fixture.activities;

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ModuleLogger;
  const registry = createSkillRegistry({ dataDirectory: root, logger });
  const state = createLearningState(join(root, 'learning'));
  await Promise.all([registry.start(), state.start()]);
  registry.claimNamespace(LEARNING_EXTENSION_ID, LEARNING_SKILL_NAMESPACE);
  const skills = registry.forNamespace(LEARNING_SKILL_NAMESPACE);

  const { runChild, createChildSession } = childHarness();
  const worker = createLearningWorker({
    activities: episodes,
    skills,
    state,
    createChildSession,
    getModelPurpose: () => 'memory',
    getAgent: () => ({ name: 'Atlas', soul: 'Product manager.' }),
    logger,
    now: fixture.now,
  });
  worker.start();
  cleanup.push(
    () => registry.close(),
    () => worker.close(),
  );
  return { root, episodes, ids: fixture.ids, skills, state, runChild, worker };
}

describe('learning fixtures', () => {
  it('reads raw SQLite fixtures through the filtered history view', async () => {
    const { episodes, ids } = await harness();
    expect((await episodes.manifest()).map((ref) => ref.id)).toEqual(ids);
    for (const id of ids) {
      const page = await episodes.readPage(id, {
        offset: 0,
        limit: 12000,
        maxBytes: 10000,
      });
      expect(page?.text).toContain('your_output');
      expect(page?.truncated).toBe(false);
    }
  });

  it('runs extraction end to end and records provenance', async () => {
    const {
      skills,
      state,
      runChild,
      worker,
      ids: [feedbackId, fixId, noLessonId],
    } = await harness();
    const dropped = [feedbackId, fixId, noLessonId].map((id) =>
      messageIdOf(id as string),
    );

    runChild.mockImplementationOnce(async ({ system, prompt }) => {
      expect(system).toContain('### How to determine learning');
      expect(system).toContain('AI Agent *Atlas*');
      expect(system).toContain('<soul>Product manager.</soul>');
      expect(system).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(prompt).toContain('<skills>\n(none)\n</skills>');
      // One compaction yields one block covering everything it dropped.
      expect(prompt).toContain(`<activity id="${noLessonId}"`);
      expect(prompt).toContain('always ask before changing a core contract');
      expect(prompt).toContain('Node.js 26 is required');
      expect(prompt).toContain('team lunch');
      return reply(
        {
          op: 'create',
          name: 'ask-before-core-contract-changes',
          description:
            'Use before changing a published protocol, payload, or other core contract.',
          body: '1. Propose the change and its impact.\n2. Wait for approval before editing.',
          reason: 'Teammate asked to be consulted first.',
        },
        {
          op: 'create',
          name: 'use-pinned-node-version',
          description:
            'Use before running repository scripts on a machine whose default Node may be older.',
          body: 'Run `nvm use` in the repository root first; it reads `.nvmrc`.',
          reason: 'A failed run succeeded after switching Node.',
        },
      );
    });

    await worker.onCompaction(dropped);
    expect(runChild).toHaveBeenCalledTimes(1);

    expect(skills.list().map((skill) => skill.name)).toEqual([
      'ask-before-core-contract-changes',
      'use-pinned-node-version',
    ]);
    expect(state.get().cursor).toBe(noLessonId);
    expect(state.get().lastConsolidationAt).toBeNull();
  });

  it('writes learned skills as Agent Skills files in the learning namespace', async () => {
    const {
      root,
      runChild,
      worker,
      ids: [, , lastId],
    } = await harness();
    runChild
      .mockResolvedValueOnce(
        reply({
          op: 'create',
          name: 'ask-before-core-contract-changes',
          description: 'Use before changing a core contract.',
          body: 'Ask first.',
          reason: 'feedback',
        }),
      )
      .mockResolvedValue(reply());

    await worker.onCompaction([messageIdOf(lastId as string)]);

    const content = await readFile(
      join(
        root,
        'skills',
        LEARNING_SKILL_NAMESPACE,
        'ask-before-core-contract-changes',
        'SKILL.md',
      ),
      'utf8',
    );
    expect(content).toBe(
      '---\nname: "ask-before-core-contract-changes"\n' +
        'description: "Use before changing a core contract."\n---\n\nAsk first.\n',
    );
  });
});

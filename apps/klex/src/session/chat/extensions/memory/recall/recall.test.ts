import type { ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { createActivityFixture } from '@/activity-history/test-support';
import type {
  Extension,
  StepCompleteEvent,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { ChildSessionHandle, ChildSessionOptions } from '@/session/types';
import { makeDeps } from '@/shared-utilities/test-utils';

import { createMemoryRecall } from './recall';

vi.mock('./system-prompt.md', () => ({
  default: 'Recall until answerRecall.',
}));

function tools(extension: Extension): ToolSet {
  if (!extension.getTools) throw new Error('Missing tools');
  return extension.getTools({} as never);
}
async function call(
  set: ToolSet,
  name: string,
  input: unknown,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const tool = set[name];
  if (!tool?.execute) throw new Error(`Missing executable tool: ${name}`);
  return tool.execute(input as never, {
    context: undefined,
    toolCallId: 'test',
    messages: [],
    abortSignal,
  });
}
function setup() {
  let reader: Extension;
  let options: ChildSessionOptions;
  const messages: ExtendedUIMessage[] = [
    {
      id: 'main',
      role: 'user',
      parts: [
        {
          type: 'data-loadedMemories',
          data: {
            'person/ada.md': JSON.stringify({
              version: 1,
              kind: 'entity',
              title: 'Ada',
              body: 'Owns deployment',
              sections: ['Details'],
            }),
          },
        } as never,
      ],
    },
  ];
  const activities = {
    latest: vi.fn(async () => []),
    manifest: vi.fn(async () => [{ id: 'source-1', bytes: 100 }]),
    readPage: vi.fn(async () => ({
      text: 'deployment evidence',
      scannedBytes: 100,
      truncated: false,
    })),
    listNeighbors: vi.fn(async () => []),
  };
  const skills = {
    snapshot: vi.fn(async () => []),
    readReference: vi.fn(() => null),
  };
  const source = {
    snapshot: vi.fn(async () => []),
    getHistory: () => messages,
  };
  const child = {
    sessionId: 'recall-child',
    inbox: { sendMessage: vi.fn(() => true) },
    close: vi.fn(async () => undefined),
    getSessionInfo: vi.fn(() => ({ status: 'active' })),
    waitForIdle: vi.fn(async () => {
      await call(tools(reader), 'answerRecall', {
        answer: 'Ada owns deployment. [person/ada]',
      });
      return true;
    }),
  };
  const readerInbox = { sendMessage: vi.fn(() => true) };
  const deps = makeDeps({
    createChildSession: vi.fn(async (requested: ChildSessionOptions) => {
      options = requested;
      const factory = requested.extensions.find((factory) =>
        factory.identifier.endsWith('-reader'),
      );
      if (!factory) throw new Error('Missing reader');
      reader = factory.create(makeDeps({ inbox: readerInbox as never }));
      return child as unknown as ChildSessionHandle;
    }),
  });
  const recall = createMemoryRecall({
    time: { timeUpdatePeriod: 60, timezone: 'Europe/Berlin' },
    activities: activities as never,
    skills: skills as never,
  });
  const detach = recall.attachSource(source);
  const extension = recall.extension.create(deps);
  return {
    recall,
    readerInbox,
    detach,
    extension,
    child,
    activities,
    skills,
    source,
    deps,
    messages,
    reader: () => reader,
    options: () => options,
  };
}

describe('temporary memory recall', () => {
  it('inherits the same compact facts, identities, catalogue deltas and skill diffs as main context', async () => {
    const h = setup();
    const entity = JSON.stringify({
      version: 1,
      kind: 'entity',
      title: 'Ada',
      tags: ['people/humans', 'people/bots'],
      linkedIdentities: [
        {
          server: 'github',
          match: { repositoryId: '123', subjectNodeId: 'PR_123' },
        },
      ],
      body: 'Owns deployment',
      sections: ['Work', 'Details'],
    });
    const skill = (last: string) =>
      JSON.stringify({
        version: 1,
        kind: 'skill',
        title: 'test',
        body: `${'Stable instruction\n'.repeat(30)}${last}`,
        sections: [],
      });
    h.messages[0]!.parts = [
      {
        type: 'data-loadedMemories',
        data: {
          'extensions/io.stagewise/memory/entities/Ada.md': entity,
          'skills/test/SKILL.md': skill('Old'),
        },
      },
      {
        type: 'data-availableSkills',
        data: [
          { name: 'test', description: 'Old description' },
          { name: 'stable', description: 'Same' },
          { name: 'gone', description: 'Deleted' },
        ],
      },
    ] as never;
    h.messages.push({
      id: 'next',
      role: 'assistant',
      parts: [
        {
          type: 'data-loadedMemories',
          data: {
            'extensions/io.stagewise/memory/entities/Ada.md': entity,
            'skills/test/SKILL.md': skill('New'),
          },
        },
        {
          type: 'data-availableSkills',
          data: [
            { name: 'test', description: 'Updated description' },
            { name: 'stable', description: 'Same' },
            { name: 'new', description: 'New skill' },
          ],
        },
      ] as never,
    });
    await call(tools(h.extension), 'recallFromMemory', {
      question: 'Recall formatting',
    });
    const sent = (
      h.child.inbox.sendMessage.mock.calls as unknown[][]
    )[0]?.[0] as ExtendedUIMessage;
    const text = sent.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n');
    expect(text).toContain('memory "Ada.md"\ntags\n¦people/humans,people/bots');
    expect(text).toContain('facts\n¦Owns deployment');
    expect(text).toContain(
      'linkedIdentities\n¦github:\n¦  repositoryId: 123\n¦  subjectNodeId: PR_123',
    );
    expect(text).toContain('additionalSections\n¦- Work\n¦- Details');
    expect(text).not.toContain('title="Ada"');
    expect(text).not.toContain('&quot;');
    expect(text).toContain('skill-update test\npatch');
    expect(text).toContain('¦-Old\n¦+New');
    const delta = text.split('available-skills-change\n')[1]?.split('\n\n')[0];
    expect(delta).toContain('New:');
    expect(delta).toContain('Updated:');
    expect(delta).toContain('Deleted: gone');
    expect(delta).not.toContain('stable');
  });
  it('waits for answerRecall, inherits main memory, and automatically closes its isolated child', async () => {
    const h = setup();
    expect(Object.keys(tools(h.extension))).toEqual(['recallFromMemory']);
    await expect(
      call(tools(h.extension), 'recallFromMemory', {
        question: 'Who owns deployment?',
      }),
    ).resolves.toEqual({ answer: 'Ada owns deployment. [person/ada]' });
    expect(h.options()).toMatchObject({
      name: 'memory-recall',
      modelPurpose: 'memory',
      fallbackModelPurposes: ['chat'],
    });
    expect(h.child.inbox.sendMessage.mock.calls[0]).toBeDefined();
    const sent = (
      h.child.inbox.sendMessage.mock.calls as unknown[][]
    )[0]?.[0] as ExtendedUIMessage;
    expect(JSON.stringify(sent)).toContain('Owns deployment');
    expect(JSON.stringify(sent)).toContain('memory ');
    expect(JSON.stringify(sent)).toContain('Who owns deployment?');
    expect(h.child.close).toHaveBeenCalledOnce();
  });

  it('loads the configured name and timezone-aware time as isolated extensions', async () => {
    const h = setup();
    await call(tools(h.extension), 'recallFromMemory', { question: 'Recall' });
    const factories = h.options().extensions;
    expect(factories.map(({ identifier }) => identifier)).toContain(
      'io.stagewise/name-loader',
    );
    expect(factories.map(({ identifier }) => identifier)).toContain(
      'io.stagewise/time',
    );
    const deps = makeDeps({
      config: { get: () => ({ officialName: '  Recall Agent  ' }) } as never,
    });
    const name = factories
      .find(({ identifier }) => identifier === 'io.stagewise/name-loader')
      ?.create(deps);
    expect(name?.getSystemPromptPart?.()).toBe('## Your name\n\nRecall Agent');
    const time = factories
      .find(({ identifier }) => identifier === 'io.stagewise/time')
      ?.create(deps);
    const context = time?.getProvisionalStepContext?.([], {} as never);
    expect(JSON.stringify(context)).toContain('Europe/Berlin');
    expect(Object.keys(time?.getTools?.({} as never) ?? {})).toEqual([
      'getTime',
    ]);
  });

  it('exposes only read capabilities and a terminal answer tool', async () => {
    const h = setup();
    await call(tools(h.extension), 'recallFromMemory', {
      question: 'Find evidence',
    });
    const set = tools(h.reader());
    expect(Object.keys(set).sort()).toEqual(
      [
        'answerRecall',
        'listEntities',
        'readEntity',
        'listSkills',
        'readSkill',
        'searchHistory',
        'listHistory',
        'readHistory',
        'listRecentHistory',
        'listHistoryNeighbors',
      ].sort(),
    );
    await call(set, 'searchHistory', { query: 'deploy', offset: 0 });
    expect(h.activities.manifest).toHaveBeenCalled();
    expect(h.activities.readPage).toHaveBeenCalledWith(
      'source-1',
      expect.objectContaining({ view: expect.any(Function) }),
    );
    await call(set, 'readEntity', { id: 'missing', sections: [] });
    expect(h.source.snapshot).toHaveBeenCalled();
    expect(await call(set, 'answerRecall', { answer: 'duplicate' })).toEqual({
      accepted: false,
    });
  });

  it('renders memory reads like inherited context while retaining evidence and hiding editing metadata', async () => {
    const h = setup();
    await call(tools(h.extension), 'recallFromMemory', { question: 'Recall' });
    h.source.snapshot.mockResolvedValue([
      {
        id: 'Ada',
        frontmatter: { Tags: ['people'], LinkedIdentities: [] },
        sections: {
          General: [
            {
              text: 'Leads design',
              sources: [{ label: 'Evidence', id: 'source-1' }],
              history: [
                {
                  text: 'Designed icons',
                  sources: [{ label: 'Earlier', id: 'source-0' }],
                },
              ],
            },
          ],
          Role: [{ text: 'Owns roadmap', sources: [], history: [] }],
        },
      },
    ] as never);
    const set = tools(h.reader());
    const general = await call(set, 'readEntity', { id: 'Ada', sections: [] });
    expect(general).toContain('memory "Ada.md"\ntags\n¦people');
    expect(general).toContain('additionalSections\n¦- Role');
    expect(general).toContain(
      'facts\n¦- Leads design [Evidence](history:source-1)',
    );
    expect(general).toContain(
      'was: Designed icons [Earlier](history:source-0)',
    );
    expect(general).not.toContain('revision');
    expect(general).not.toContain('Owns roadmap');
    const detailed = await call(set, 'readEntity', {
      id: 'Ada',
      sections: ['Role'],
    });
    expect(detailed).toContain(
      'memory-detail "Ada.md" section="Role"\nfacts\n¦- Owns roadmap',
    );
    h.skills.snapshot.mockResolvedValue([
      {
        id: 'learning/deploy',
        description: 'Deploying',
        body: 'Push first',
        references: ['flags'],
        metadata: { internal: true },
      },
    ] as never);
    const skill = await call(set, 'readSkill', { skill: 'learning/deploy' });
    expect(skill).toContain(
      'skill learning/deploy\ndescription\n¦Deploying\ncontent\n¦Push first',
    );
    expect(skill).not.toContain('metadata');
    h.skills.readReference.mockReturnValue('Use --dry-run' as never);
    expect(
      await call(set, 'readSkill', {
        skill: 'learning/deploy',
        reference: 'flags',
      }),
    ).toBe(
      'skill-reference learning/deploy reference="flags"\ncontent\n¦Use --dry-run',
    );
  });

  it('preserves search matches and scans later sources after a read failure', async () => {
    const h = setup();
    await call(tools(h.extension), 'recallFromMemory', { question: 'Recall' });
    h.activities.manifest.mockResolvedValue([
      { id: 'last', bytes: 100 },
      { id: 'broken', bytes: 100 },
      { id: 'first', bytes: 100 },
    ]);
    h.activities.readPage.mockImplementation(async (id?: string) => {
      if (id === 'broken') throw new Error('unavailable');
      return {
        text: 'deployment evidence',
        scannedBytes: 100,
        truncated: false,
      };
    });
    expect(
      await call(tools(h.reader()), 'searchHistory', {
        query: 'deployment',
        offset: 0,
      }),
    ).toMatchObject({
      matches: [{ id: 'first' }, { id: 'last' }],
      unavailable: 1,
      truncated: true,
    });
  });

  it.each(['caller', 'deadline'] as const)(
    'closes the child immediately on %s cancellation',
    async (kind) => {
      vi.useFakeTimers();
      try {
        const h = setup();
        const abort = new AbortController();
        let release!: (idle: boolean) => void;
        h.child.waitForIdle.mockImplementation(
          () =>
            new Promise<boolean>((resolve) => {
              release = resolve;
            }),
        );
        const pending = call(
          tools(h.extension),
          'recallFromMemory',
          { question: 'Recall' },
          abort.signal,
        );
        await vi.advanceTimersByTimeAsync(0);
        if (kind === 'caller') abort.abort();
        else await vi.advanceTimersByTimeAsync(300_000);
        expect(h.child.close).toHaveBeenCalledOnce();
        release(false);
        await pending;
        expect(h.child.close).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('stops an unanswered helper at its step budget', async () => {
    const h = setup();
    h.child.waitForIdle.mockImplementation(async () => {
      await h.reader().onStepComplete?.({
        generation: {},
        shouldContinue: true,
      } as StepCompleteEvent);
      if (h.child.waitForIdle.mock.calls.length === 20)
        expect(h.child.close).toHaveBeenCalledOnce();
      return false;
    });
    expect(
      await call(tools(h.extension), 'recallFromMemory', {
        question: 'Recall',
      }),
    ).toMatchObject({ error: expect.stringContaining('Do not retry') });
    expect(h.child.waitForIdle).toHaveBeenCalledTimes(20);
    expect(h.child.close).toHaveBeenCalledOnce();
  });

  it('forces plain-text helper steps to continue until an answer tool call', async () => {
    const h = setup();
    h.child.waitForIdle.mockImplementationOnce(async () => {
      const event = {
        generation: {},
        shouldContinue: false,
        forceNextStep: false,
      } as StepCompleteEvent;
      await h.reader().onStepComplete?.(structuredClone(event));
      expect(event.forceNextStep).toBe(false);
      expect(h.readerInbox.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'user' }),
        expect.anything(),
      );
      await call(tools(h.reader()), 'answerRecall', { answer: 'Done' });
      return true;
    });
    await expect(
      call(tools(h.extension), 'recallFromMemory', { question: 'Recall' }),
    ).resolves.toEqual({ answer: 'Done' });
  });

  it('keeps oversized text, tool and event evidence available to the history pager', async () => {
    const h = setup();
    await call(tools(h.extension), 'recallFromMemory', {
      question: 'Find tail',
    });
    await call(tools(h.reader()), 'readHistory', { id: 'source-1', offset: 0 });
    const options = (h.activities.readPage.mock.calls as unknown[][]).at(
      -1,
    )?.[1] as unknown as { view: (messages: ExtendedUIMessage[]) => string };
    const long = 'x'.repeat(70000) + 'TAIL_EVIDENCE';
    const rendered = JSON.stringify(
      options.view([
        { id: 'large', role: 'user', parts: [{ type: 'text', text: long }] },
      ]),
    );
    expect(rendered).toContain('TAIL_EVIDENCE');
    expect(rendered.length).toBeGreaterThan(70000);
    const fixture = await createActivityFixture();
    try {
      const source = await fixture.append(long, 'user');
      let offset = 0;
      let evidence = '';
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = await fixture.activities.readPage(source.id, {
          offset,
          limit: 12000,
          maxBytes: 2000000,
          view: options.view as never,
        });
        expect(page).not.toBeNull();
        expect(page?.truncated).toBe(false);
        evidence += page!.text;
        if (page!.nextOffset === null) break;
        offset = page!.nextOffset;
      }
      expect(evidence).toContain(long);
    } finally {
      await fixture.close();
    }
  });

  it('does not fabricate answers if the child stops or terminates', async () => {
    const h = setup();
    h.child.waitForIdle.mockImplementationOnce(async () => true);
    await expect(
      call(tools(h.extension), 'recallFromMemory', { question: 'Recall' }),
    ).resolves.toHaveProperty('error');
    expect(h.child.close).toHaveBeenCalledOnce();
  });

  it('cancels and closes a running child when the caller aborts', async () => {
    const h = setup();
    const abort = new AbortController();
    h.child.waitForIdle.mockImplementationOnce(async () => {
      abort.abort();
      return false;
    });
    await expect(
      call(
        tools(h.extension),
        'recallFromMemory',
        { question: 'Recall' },
        abort.signal,
      ),
    ).resolves.toEqual({ error: 'Recall cancelled' });
    expect(h.child.close).toHaveBeenCalledOnce();
  });

  it('shares main-session memories with a consult-owned recall extension', async () => {
    const h = setup();
    const consult = h.recall.extension.create(
      makeDeps({
        getHistory: () => [],
        createChildSession: h.deps.createChildSession,
      }),
    );
    await call(tools(consult), 'recallFromMemory', {
      question: 'Consult question',
    });
    expect(JSON.stringify(h.child.inbox.sendMessage.mock.calls)).toContain(
      'Owns deployment',
    );
    h.detach();
    await expect(
      call(tools(consult), 'recallFromMemory', { question: 'Again' }),
    ).resolves.toEqual({ error: 'Memory source unavailable' });
  });

  it('reads user text and tool evidence with the recall projection, not the learning view', async () => {
    const h = setup();
    await call(tools(h.extension), 'recallFromMemory', { question: 'Recall' });
    await call(tools(h.reader()), 'readHistory', { id: 'source-1', offset: 0 });
    const options = (h.activities.readPage.mock.calls as unknown[][]).at(
      -1,
    )?.[1] as { view: (messages: ExtendedUIMessage[]) => unknown };
    const projected = JSON.stringify(
      options.view([
        {
          id: 'evidence',
          role: 'user',
          parts: [{ type: 'text', text: 'Original user evidence' }],
        },
      ]),
    );
    expect(projected).toContain('Original user evidence');
  });

  it('reports partially searched sources and their continuation offsets', async () => {
    const h = setup();
    h.activities.readPage.mockResolvedValue({
      text: 'No matching text',
      scannedBytes: 70000,
      truncated: false,
      nextOffset: 60000,
    } as never);
    await call(tools(h.extension), 'recallFromMemory', { question: 'Recall' });
    const result = await call(tools(h.reader()), 'searchHistory', {
      query: 'absent',
      offset: 0,
    });
    expect(result).toMatchObject({
      matches: [],
      incomplete: [{ id: 'source-1', nextOffset: 60000 }],
      truncated: true,
      unavailable: 0,
    });
  });

  it('paginates the entire retained history manifest beyond 200 sources', async () => {
    const h = setup();
    h.activities.manifest.mockResolvedValue(
      Array.from({ length: 350 }, (_, index) => ({
        id: `source-${index}`,
        bytes: 100,
      })),
    );
    await call(tools(h.extension), 'recallFromMemory', { question: 'Recall' });
    const result = await call(tools(h.reader()), 'searchHistory', {
      query: 'absent',
      offset: 200,
    });
    expect(result).toMatchObject({ matches: [], nextOffset: 300 });
    expect(h.activities.readPage).toHaveBeenCalledTimes(100);
    expect(h.activities.readPage).toHaveBeenCalledWith(
      'source-149',
      expect.any(Object),
    );
  });

  it('closes pending helpers when the caller extension shuts down', async () => {
    const h = setup();
    h.child.waitForIdle.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return false;
    });
    const operation = call(tools(h.extension), 'recallFromMemory', {
      question: 'Recall',
    });
    await vi.waitFor(() => expect(h.child.waitForIdle).toHaveBeenCalled());
    await h.extension.onClose?.();
    await expect(operation).resolves.toEqual({ error: 'Recall cancelled' });
    expect(h.child.close).toHaveBeenCalledOnce();
  });

  it('closes a helper that terminates without answering', async () => {
    const h = setup();
    h.child.getSessionInfo.mockReturnValue({ status: 'terminated' });
    await expect(
      call(tools(h.extension), 'recallFromMemory', { question: 'Recall' }),
    ).resolves.toHaveProperty('error');
    expect(h.child.close).toHaveBeenCalledOnce();
  });

  it('does not let stale detach callbacks remove a replacement source', async () => {
    const h = setup();
    h.recall.attachSource(h.source);
    h.detach();
    // Reattaching the same handle is intentionally the same owner; a new source is distinct.
    h.recall.attachSource({ ...h.source });
    h.detach();
    await expect(
      call(tools(h.extension), 'recallFromMemory', { question: 'Recall' }),
    ).resolves.toHaveProperty('answer');
  });
});

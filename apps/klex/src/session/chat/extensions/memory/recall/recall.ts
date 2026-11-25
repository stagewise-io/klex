import { randomUUID } from 'node:crypto';

import type { ToolSet } from 'ai';
import { z } from 'zod';

import type { ActivityHistory } from '@/activity-history';
import { createContextCompactionExtForPurpose } from '@/session/chat/extensions/context-compaction';
import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  StepCompleteEvent,
} from '@/session/chat/extensions/extension-api';
import {
  formatMemory,
  formatSkill,
  materializeMemories,
  materializeSkills,
} from '@/session/chat/extensions/memory/loading';
import {
  formatFacts,
  type MemoryEntity,
} from '@/session/chat/extensions/memory/writer/entities';
import { createNameLoaderExt } from '@/session/chat/extensions/name-loader';
import {
  createTimeExt,
  type TimeExtConfig,
} from '@/session/chat/extensions/time';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  createHistoryView,
  LINES_FORMAT_PROMPT,
} from '@/session/chat/utils/history-view';
import { SessionInboxUrgency } from '@/session/inbox';
import type { ChildSessionHandle } from '@/session/types';
import type { SkillRegistry } from '@/skills';

import prompt from './system-prompt.md';

export interface MemoryRecallSource {
  snapshot(): Promise<MemoryEntity[]>;
  getHistory(): ExtendedUIMessage[];
}
export interface MemoryRecall {
  readonly extension: ExtensionFactory;
  attachSource(source: MemoryRecallSource): () => void;
}
export interface MemoryRecallOptions {
  time: TimeExtConfig;
  activities: Pick<
    ActivityHistory,
    'latest' | 'manifest' | 'readPage' | 'listNeighbors'
  >;
  skills: Pick<SkillRegistry, 'snapshot' | 'readReference'>;
}

// Recall reads canonical evidence, not the deliberately lossy learning projection.
const recallHistory = createHistoryView({
  filter: {
    text: {
      roles: ['user', 'assistant'],
      limit: { max: Number.MAX_SAFE_INTEGER, truncate: 'end' },
    },
    reasoning: false,
    tools: {
      input: { max: Number.MAX_SAFE_INTEGER, truncate: 'end', json: 'plain' },
      output: { max: Number.MAX_SAFE_INTEGER, truncate: 'end', json: 'plain' },
      error: { max: Number.MAX_SAFE_INTEGER, truncate: 'end' },
      skip: (name) => name === 'recall' || name === 'recallFromMemory',
    },
    context: {
      metadata: {
        max: Number.MAX_SAFE_INTEGER,
        truncate: 'end',
        json: 'plain',
      },
      text: { max: Number.MAX_SAFE_INTEGER, truncate: 'end' },
      resources: { limit: { max: Number.MAX_SAFE_INTEGER, truncate: 'end' } },
      media: 'placeholder',
    },
    summary: false,
  },
  // ActivityHistory paginates the rendered evidence. Never truncate before paging.
  lines: {},
});

/** Copy rendered context, not transcript/tool turns or live mutable store objects. */
function inheritedContext(
  history: ExtendedUIMessage[],
): ExtendedUIMessage['parts'] {
  const selected = history.map((message) => ({
    ...message,
    parts: message.parts.filter(
      (part) =>
        [
          'data-loadedMemories',
          'data-loadedMemorySections',
          'data-availableSkills',
          'data-activeSkills',
          'data-memoryLoadingStatus',
          'data-context-summary',
        ].includes(part.type) ||
        ((part.type === 'tool-readMemorySection' ||
          (part.type === 'dynamic-tool' &&
            part.toolName === 'readMemorySection')) &&
          part.state === 'output-available'),
    ),
  }));
  return materializeMemories(
    materializeSkills(structuredClone(selected)),
  ).flatMap((message) => message.parts.filter((part) => part.type === 'text'));
}

class RecallReader implements Extension {
  private answered = false;
  private steps = 0;
  constructor(
    private readonly options: MemoryRecallOptions,
    private readonly source: MemoryRecallSource,
    private readonly inbox: ExtensionDeps['inbox'],
    private readonly answer: (answer: string) => void,
    private readonly exhausted: () => void,
  ) {}

  onStepComplete(event: StepCompleteEvent): void {
    if (!this.answered && ++this.steps >= 20) {
      this.exhausted();
      return;
    }
    // Plain assistant text is not an answer. Keep working until answerRecall.
    if (
      !this.answered &&
      event.generation &&
      !event.generationFailed &&
      !event.fatalError &&
      !event.shouldContinue
    )
      this.inbox.sendMessage(
        {
          id: randomUUID(),
          role: 'user',
          parts: [
            {
              type: 'text',
              text: 'Continue recall. Finish by calling answerRecall, including when no relevant evidence was found.',
            },
          ],
        },
        SessionInboxUrgency.Default,
      );
  }

  getTools(): ToolSet {
    const { activities, skills } = this.options;
    return {
      answerRecall: {
        description:
          'Finish recall with an evidence-grounded answer, or explicitly state that nothing relevant was found. This closes the helper.',
        inputSchema: z
          .object({ answer: z.string().trim().min(1).max(24000) })
          .strict(),
        execute: async ({ answer }) => {
          if (this.answered) return { accepted: false };
          this.answered = true;
          this.answer(answer);
          return { accepted: true };
        },
      },
      listEntities: {
        description:
          'Search memory names, types, identities, relations and facts by case-insensitive literal terms. Empty query lists all. Paginated.',
        inputSchema: z
          .object({
            query: z.string().max(200).default(''),
            offset: z.number().int().min(0).default(0),
          })
          .strict(),
        execute: async ({ query, offset }) => {
          const terms: string[] = query
            .toLowerCase()
            .split(/\s+/u)
            .filter(Boolean);
          const matches = (await this.source.snapshot())
            .filter(
              (entity) =>
                !terms.length ||
                terms.some((term) =>
                  JSON.stringify(entity).toLowerCase().includes(term),
                ),
            )
            .sort((a, b) => a.id.localeCompare(b.id));
          return {
            entities: matches.slice(offset, offset + 20).map((entity) => ({
              id: entity.id,
              title: entity.id,
              tags: entity.frontmatter.Tags,
              sections: Object.keys(entity.sections),
            })),
            nextOffset: offset + 20 < matches.length ? offset + 20 : null,
          };
        },
      },
      readEntity: {
        description:
          'Read General and requested detail sections, including sources and prior fact versions. Omit sections to read General only.',
        inputSchema: z
          .object({
            id: z.string().min(1).max(1000),
            sections: z.array(z.string().max(100)).max(50).default([]),
          })
          .strict(),
        execute: async ({ id, sections }) => {
          const entity = (await this.source.snapshot()).find(
            (item) => item.id === id,
          );
          if (!entity) return { error: 'Memory not found' };
          return [
            formatMemory(
              {
                version: 1,
                kind: 'entity',
                title: entity.id,
                tags: entity.frontmatter.Tags,
                linkedIdentities: entity.frontmatter.LinkedIdentities,
                sections: Object.keys(entity.sections).filter(
                  (name) => name !== 'General',
                ),
                body: formatFacts(entity.sections.General ?? []),
              },
              `${entity.id}.md`,
            ),
            ...Object.entries(entity.sections)
              .filter(([name]) => name !== 'General' && sections.includes(name))
              .map(([section, facts]) =>
                formatMemory(
                  {
                    version: 1,
                    kind: 'detail',
                    title: entity.id,
                    section,
                    sections: [],
                    body: formatFacts(facts),
                  },
                  `${entity.id}.md`,
                ),
              ),
          ].join('\n\n');
        },
      },
      listSkills: {
        description:
          'List available skills and their reference names, read-only.',
        inputSchema: z
          .object({ offset: z.number().int().min(0).default(0) })
          .strict(),
        execute: async ({ offset }) => {
          const all = await skills.snapshot();
          return {
            skills: all
              .slice(offset, offset + 40)
              .map(({ id, description, references }) => ({
                id,
                description,
                references,
              })),
            nextOffset: offset + 40 < all.length ? offset + 40 : null,
          };
        },
      },
      readSkill: {
        description:
          'Read a skill or one of its references without editing it.',
        inputSchema: z
          .object({
            skill: z.string().min(1),
            reference: z.string().min(1).optional(),
          })
          .strict(),
        execute: async ({ skill, reference }) => {
          const item = (await skills.snapshot()).find(
            (entry) => entry.id === skill,
          );
          if (!item) return { error: 'Unknown skill' };
          if (reference === undefined)
            return formatSkill(
              {
                title: item.id,
                description: item.description,
                body: item.body,
                references: item.references,
              },
              { referenceTool: 'readSkill' },
            );
          const content = skills.readReference(skill, reference);
          return content === null
            ? { error: 'Unknown reference' }
            : formatSkill({ title: item.id, body: content }, { reference });
        },
      },
      listHistory: {
        description:
          'List retained canonical history source IDs, oldest first, with pagination.',
        inputSchema: z
          .object({ offset: z.number().int().min(0).default(0) })
          .strict(),
        execute: async ({ offset }) => {
          const sources = await activities.manifest();
          return {
            sources: sources.slice(offset, offset + 100),
            nextOffset: offset + 100 < sources.length ? offset + 100 : null,
          };
        },
      },
      searchHistory: {
        description:
          'Search retained canonical activity history. Follow nextOffset when truncated; missing evidence may have expired from retention.',
        inputSchema: z
          .object({
            query: z.string().trim().min(1).max(200),
            offset: z.number().int().min(0).default(0),
          })
          .strict(),
        execute: async ({ query, offset }) => {
          const sources = (await activities.manifest()).reverse();
          const matches: { id: string; snippet: string }[] = [];
          let index = offset;
          let scannedBytes = 0;
          let unavailable = 0;
          const incomplete: { id: string; nextOffset: number }[] = [];
          while (
            index < sources.length &&
            index < offset + 100 &&
            scannedBytes < 2000000 &&
            matches.length < 20
          ) {
            const source = sources[index++];
            if (!source) break;
            const page = await activities
              .readPage(source.id, {
                offset: 0,
                limit: 60000,
                maxBytes: 2000000 - scannedBytes,
                view: (messages) => recallHistory.fit(messages),
              })
              .catch(() => null);
            scannedBytes += Math.max(source.bytes, page?.scannedBytes ?? 0);
            if (!page || page.truncated) unavailable++;
            if (page?.nextOffset != null)
              incomplete.push({ id: source.id, nextOffset: page.nextOffset });
            const found =
              page?.text.toLowerCase().indexOf(query.toLowerCase()) ?? -1;
            if (found >= 0 && page)
              matches.push({
                id: source.id,
                snippet: page.text.slice(
                  Math.max(0, found - 150),
                  found + query.length + 300,
                ),
              });
          }
          return {
            matches,
            nextOffset: index < sources.length ? index : null,
            scannedBytes,
            unavailable,
            incomplete,
            truncated:
              unavailable > 0 ||
              incomplete.length > 0 ||
              index < sources.length,
            note: 'Search inspects the first 60000 rendered characters per source; use readHistory to paginate a source.',
          };
        },
      },
      readHistory: {
        description:
          'Read a canonical activity page by exact source ID; follow nextOffset for more.',
        inputSchema: z
          .object({
            id: z.string().min(1),
            offset: z.number().int().min(0).default(0),
          })
          .strict(),
        execute: async ({ id, offset }) =>
          activities.readPage(id, {
            offset,
            limit: 12000,
            maxBytes: 2000000,
            view: (messages) => recallHistory.fit(messages),
          }),
      },
      listRecentHistory: {
        description:
          'List the latest retained activities to obtain source IDs.',
        inputSchema: z
          .object({ count: z.number().int().min(1).max(40).default(20) })
          .strict(),
        execute: async ({ count }) => activities.latest(count),
      },
      listHistoryNeighbors: {
        description:
          'Find activities immediately before and after a known source ID.',
        inputSchema: z
          .object({
            id: z.string().min(1),
            count: z.number().int().min(1).max(5).default(2),
          })
          .strict(),
        execute: async ({ id, count }) => activities.listNeighbors(id, count),
      },
    };
  }
}

class RecallExtension implements Extension {
  private closed = false;
  private readonly pending = new Set<AbortController>();
  private readonly operations = new Set<Promise<unknown>>();
  constructor(
    private readonly deps: ExtensionDeps,
    private readonly options: MemoryRecallOptions,
    private readonly source: () => MemoryRecallSource | undefined,
  ) {}

  getSystemPromptPart(): string {
    return 'Use recallFromMemory(question) when you need evidence from durable memories, skills, or older activity history. It returns the answer from a temporary read-only helper; do not invent missing memories.';
  }

  getTools(): ToolSet {
    return {
      recallFromMemory: {
        description:
          'Ask a temporary read-only helper to recall evidence from memories, skills and retained activity history. Waits for its answer, then closes the helper.',
        inputSchema: z
          .object({ question: z.string().trim().min(1).max(12000) })
          .strict(),
        execute: ({ question }, { abortSignal }) => {
          const operation = this.recall(question, abortSignal);
          this.operations.add(operation);
          void operation
            .finally(() => this.operations.delete(operation))
            .catch(() => undefined);
          return operation;
        },
      },
    };
  }

  private async recall(
    question: string,
    signal?: AbortSignal,
  ): Promise<{ answer: string } | { error: string }> {
    const source = this.source();
    if (this.closed) return { error: 'Recall is closed' };
    if (!source) return { error: 'Memory source unavailable' };
    const abort = new AbortController();
    let child: ChildSessionHandle | undefined;
    let closing: Promise<void> | undefined;
    const closeChild = () => {
      if (child && !closing)
        closing = child.close().catch((error: unknown) => {
          this.deps.logger.warn({ error }, 'Memory recall cleanup failed');
        });
      return closing;
    };
    abort.signal.addEventListener(
      'abort',
      () => {
        void closeChild();
      },
      { once: true },
    );
    let budgetExceeded = false;
    const exhaust = () => {
      budgetExceeded = true;
      abort.abort();
    };
    const deadline = setTimeout(exhaust, 300_000);
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    this.pending.add(abort);
    let answer: string | undefined;
    let terminated = false;
    try {
      abort.signal.throwIfAborted();
      const context = inheritedContext(source.getHistory());
      child = await this.deps.createChildSession({
        name: 'memory-recall',
        extensionIdentifier: 'io.stagewise/memory-recall',
        modelPurpose: 'memory',
        fallbackModelPurposes: ['chat'],
        basePrompt: `${prompt.trimEnd()}\n\n${LINES_FORMAT_PROMPT}`,
        extensions: [
          createNameLoaderExt,
          createTimeExt(this.options.time),
          createContextCompactionExtForPurpose('memory'),
          {
            identifier: 'io.stagewise/memory-recall-reader',
            create: (deps) =>
              new RecallReader(
                this.options,
                source,
                deps.inbox,
                (value) => {
                  answer ??= value;
                },
                exhaust,
              ),
          },
        ],
        hooks: {
          onTerminated: () => {
            terminated = true;
          },
        },
      });
      if (abort.signal.aborted) void closeChild();
      abort.signal.throwIfAborted();
      if (
        child.inbox.sendMessage(
          {
            id: randomUUID(),
            role: 'user',
            parts: [
              ...context,
              { type: 'text', text: `Recall question:\n${question}` },
            ],
          },
          SessionInboxUrgency.Default,
        ) === false
      )
        throw new Error('Recall question delivery failed');
      while (answer === undefined) {
        abort.signal.throwIfAborted();
        if (terminated || child.getSessionInfo().status === 'terminated')
          throw new Error('Recall helper terminated without an answer');
        const idle = await child.waitForIdle(250);
        if (idle && answer === undefined)
          throw new Error('Recall helper stopped without calling answerRecall');
      }
      return { answer };
    } catch (error) {
      this.deps.logger.warn({ error }, 'Memory recall failed');
      return {
        error: budgetExceeded
          ? 'Recall exceeded its time or step budget; no answer available. Do not retry the same question.'
          : abort.signal.aborted
            ? 'Recall cancelled'
            : 'Recall failed; no answer available',
      };
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
      this.pending.delete(abort);
      await closeChild();
    }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    for (const abort of this.pending) abort.abort();
    await Promise.allSettled(this.operations);
  }
}

class MemoryRecallModule implements MemoryRecall {
  private source: MemoryRecallSource | undefined;
  readonly extension: ExtensionFactory;
  constructor(options: MemoryRecallOptions) {
    this.extension = {
      identifier: 'io.stagewise/memory-recall',
      displayName: 'Memory recall',
      create: (deps) => new RecallExtension(deps, options, () => this.source),
    };
  }
  attachSource(source: MemoryRecallSource): () => void {
    this.source = source;
    return () => {
      if (this.source === source) this.source = undefined;
    };
  }
}
export function createMemoryRecall(options: MemoryRecallOptions): MemoryRecall {
  return new MemoryRecallModule(options);
}

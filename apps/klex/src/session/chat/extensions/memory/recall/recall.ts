import { randomUUID } from 'node:crypto';

import type { JSONValue } from '@ai-sdk/provider';
import type { ToolSet } from 'ai';
import { stringify } from 'yaml';
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

import {
  parseRecallAnswer,
  type RecallAnswer,
  recallAnswerSchema,
} from './result';
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
      input: {
        max: Number.MAX_SAFE_INTEGER,
        truncate: 'end',
        json: 'readable',
      },
      output: {
        max: Number.MAX_SAFE_INTEGER,
        truncate: 'end',
        json: 'readable',
      },
      error: { max: Number.MAX_SAFE_INTEGER, truncate: 'end' },
      skip: (name) => name === 'recall' || name === 'recallFromMemory',
    },
    context: {
      metadata: {
        max: Number.MAX_SAFE_INTEGER,
        truncate: 'end',
        json: 'readable',
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

export const RECALL_LIMITS = {
  steps: 8,
  calls: 12,
  historyCalls: 4,
  characters: 64000,
  softMs: 90000,
  hardMs: 120000,
  finalSteps: 2,
} as const;

class RecallReader implements Extension {
  private answered = false;
  private steps = 0;
  private finalSteps = 0;
  private calls = 0;
  private historyCalls = 0;
  private remaining: number = RECALL_LIMITS.characters;
  private readonly startedAt = Date.now();
  private nudged = false;
  private finalizing = false;
  scannedBytes = 0;
  private currentAllowance = 12000;
  get finishedWithoutAnswer(): boolean {
    return !this.answered && this.finalSteps >= RECALL_LIMITS.finalSteps;
  }
  private get exhausted(): boolean {
    return (
      this.finalizing ||
      this.calls >= RECALL_LIMITS.calls ||
      this.historyCalls >= RECALL_LIMITS.historyCalls ||
      this.steps >= RECALL_LIMITS.steps ||
      this.remaining <= 0 ||
      Date.now() - this.startedAt >= RECALL_LIMITS.softMs
    );
  }
  continue(): void {
    if (this.answered || this.nudged || this.finishedWithoutAnswer) return;
    this.nudged = true;
    this.inbox.sendMessage(
      {
        id: randomUUID(),
        role: 'user',
        parts: [
          {
            type: 'text',
            text: this.exhausted
              ? 'Exploration budget exhausted. Call answerRecall now with supported partial findings and uncertainty. No further retrieval.'
              : 'Finish by calling answerRecall. Retrieve only a specific missing fact, not exhaustive history.',
          },
        ],
      },
      SessionInboxUrgency.Default,
    );
  }
  constructor(
    private readonly options: MemoryRecallOptions,
    private readonly source: MemoryRecallSource,
    private readonly inbox: ExtensionDeps['inbox'],
    private readonly answer: (answer: RecallAnswer) => void,
    private readonly signal: AbortSignal,
  ) {}

  onStepComplete(event: StepCompleteEvent): void {
    if (event.generation) {
      this.nudged = false;
      if (this.finalizing) this.finalSteps++;
      else this.steps++;
      if (this.exhausted) this.finalizing = true;
    }
    // Only one continuation can be queued at a time.
    if (
      !this.answered &&
      event.generation &&
      !event.generationFailed &&
      !event.fatalError &&
      !event.shouldContinue
    )
      this.continue();
  }

  getTools(): ToolSet {
    const { activities, skills } = this.options;
    if (this.exhausted) this.finalizing = true;
    const tools: ToolSet = {
      answerRecall: {
        description:
          'Finish recall and close the helper; plain text does not finish it. Answer in 1–3 short sentences by default, with only requested facts and essential caveats. Do not include message IDs, source handles or citations unless requested or necessary to disambiguate. If nothing relevant was found, say so. Include the exact supporting entity IDs and qualified skill IDs so the caller can auto-load them; use empty lists where none apply. Select supporting detail sections and skill references separately; they also select their parents.',
        inputSchema: recallAnswerSchema.strict(),
        execute: async (input) => {
          if (this.answered) return { accepted: false };
          const result = parseRecallAnswer(input);
          if (!result) return { error: 'Invalid recall answer' };
          const ids = result.entities;
          if (ids.length) {
            const known = new Set(
              (await this.source.snapshot()).map(({ id }) => id),
            );
            const unknown = ids.filter((id) => !known.has(id));
            if (unknown.length)
              return { error: 'Unknown entity IDs', entities: unknown };
          }
          const skillIds = result.skills;
          if (skillIds.length) {
            const known = new Set(
              (await skills.snapshot()).map(({ id }) => id),
            );
            const unknown = skillIds.filter((id) => !known.has(id));
            if (unknown.length)
              return { error: 'Unknown skill IDs', skills: unknown };
          }
          const entities = result.entitySections.length
            ? await this.source.snapshot()
            : [];
          for (const { entity, section } of result.entitySections)
            if (
              !entities.some(
                (item) =>
                  item.id === entity && Object.hasOwn(item.sections, section),
              )
            )
              return { error: 'Unknown entity section', entity, section };
          for (const { skill, reference } of result.skillReferences) {
            const item = (await skills.snapshot()).find(
              (item) => item.id === skill,
            );
            if (
              !item?.references?.includes(reference) ||
              skills.readReference(skill, reference) === null
            )
              return { error: 'Unknown skill reference', skill, reference };
          }
          if (this.answered) return { accepted: false };
          this.answered = true;
          this.answer(result);
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
          'Read current General facts and requested detail sections. Enable evidence only for provenance, contradictions or historical questions; it includes sources and superseded versions.',
        inputSchema: z
          .object({
            id: z.string().min(1).max(1000),
            sections: z.array(z.string().max(100)).max(50).default([]),
            evidence: z.boolean().default(false),
          })
          .strict(),
        execute: async ({ id, sections, evidence = false }) => {
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
                body: evidence
                  ? formatFacts(entity.sections.General ?? [])
                  : (entity.sections.General ?? [])
                      .map((fact) => `- ${fact.text}`)
                      .join('\n'),
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
                    body: evidence
                      ? formatFacts(facts)
                      : facts.map((fact) => `- ${fact.text}`).join('\n'),
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
          'List retained canonical history sources, newest first. Continue only for a specific missing fact.',
        inputSchema: z
          .object({ offset: z.number().int().min(0).default(0) })
          .strict(),
        execute: async ({ offset }) => {
          const sources = (await activities.manifest()).reverse();
          return {
            sources: sources.slice(offset, offset + 100),
            nextOffset: offset + 100 < sources.length ? offset + 100 : null,
          };
        },
      },
      searchHistory: {
        description:
          'Search recent-first canonical history for a specific missing fact. Optional timestamp and exact source-environment hints are not authorization boundaries. Continue only if needed; missing evidence may have expired.',
        inputSchema: z
          .object({
            query: z.string().trim().min(1).max(200),
            after: z.iso.datetime().optional(),
            before: z.iso.datetime().optional(),
            sourceEnv: z.string().min(1).max(200).optional(),
            offset: z.number().int().min(0).default(0),
          })
          .strict(),
        execute: async ({ query, offset, after, before, sourceEnv }) => {
          const afterTime = after ? Date.parse(after) : -Infinity;
          const beforeTime = before ? Date.parse(before) : Infinity;
          const sources = (await activities.manifest())
            .filter((source) => {
              const persistedTime = Date.parse(source.persistedAt);
              return (
                (!after || persistedTime >= afterTime) &&
                (!before || persistedTime <= beforeTime)
              );
            })
            .reverse();
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
            this.signal.throwIfAborted();
            if (Date.now() - this.startedAt >= RECALL_LIMITS.softMs) break;
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
            this.scannedBytes += Math.max(
              source.bytes,
              page?.scannedBytes ?? 0,
            );
            if (!page || page.truncated) unavailable++;
            if (page?.nextOffset != null)
              incomplete.push({ id: source.id, nextOffset: page.nextOffset });
            const found =
              page?.text.toLowerCase().indexOf(query.toLowerCase()) ?? -1;
            if (
              found >= 0 &&
              page &&
              (!sourceEnv || page.platforms?.includes(sourceEnv))
            )
              matches.push({
                id: source.id,
                snippet: page.text.slice(
                  Math.max(0, found - 150),
                  found + query.length + 300,
                ),
              });
          }
          return [
            ...matches.map(
              (match) =>
                `source ${JSON.stringify(match.id)}\n${match.snippet
                  .split('\n')
                  .map((line) => `¦${line}`)
                  .join('\n')}`,
            ),
            ...(!matches.length
              ? ['No match in scanned evidence. This is not proof of absence.']
              : []),
            ...(unavailable || incomplete.length
              ? [
                  'Some evidence was unavailable or only partly searched. Search inspects at most the first 60000 rendered characters per source.',
                ]
              : []),
            ...incomplete
              .slice(0, 5)
              .map(
                (item) =>
                  `Source continuation: readHistory ${JSON.stringify({ id: item.id, offset: item.nextOffset })}`,
              ),
            ...(index < sources.length
              ? [
                  `Search continuation (same query and filters): ${JSON.stringify({ query, after, before, sourceEnv, offset: index })}`,
                ]
              : []),
          ].join('\n\n');
        },
      },
      readHistory: {
        description:
          'Read a canonical evidence page by exact source ID. Continue only if a specific needed fact lies beyond this page.',
        inputSchema: z
          .object({
            id: z.string().min(1),
            offset: z.number().int().min(0).default(0),
          })
          .strict(),
        execute: async ({ id, offset }) => {
          const page = await activities.readPage(id, {
            offset,
            limit: Math.max(1, Math.min(11000, this.currentAllowance - 1000)),
            maxBytes: 2000000,
            view: (messages) => recallHistory.fit(messages),
          });
          this.scannedBytes += page?.scannedBytes ?? 0;
          if (!page) return 'History unavailable; no evidence read.';
          return [
            `source ${JSON.stringify(id)} ${page.startedAt ?? ''}`,
            page.text,
            ...(page.nextOffset != null
              ? [
                  `Continuation: readHistory ${JSON.stringify({ id, offset: page.nextOffset })}`,
                ]
              : []),
            ...(page.truncated ? ['Evidence incomplete or bounded.'] : []),
          ].join('\n');
        },
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
    if (this.finalizing) return { answerRecall: tools.answerRecall! };
    for (const [name, tool] of Object.entries(tools)) {
      if (name === 'answerRecall' || !tool.execute) continue;
      const execute = tool.execute;
      tool.execute = async (input, context) => {
        this.signal.throwIfAborted();
        context.abortSignal?.throwIfAborted();
        if (this.exhausted) {
          this.finalizing = true;
          return 'Exploration budget exhausted. Call answerRecall with partial findings and uncertainty.';
        }
        this.calls++;
        if (name.toLowerCase().includes('history')) this.historyCalls++;
        const allowance = Math.min(12000, this.remaining);
        this.remaining -= allowance;
        this.currentAllowance = allowance;
        let used = 0;
        try {
          const output = await execute(input, context);
          const text =
            typeof output === 'string'
              ? output
              : stringify(output, {
                  lineWidth: 0,
                  aliasDuplicateObjects: false,
                });
          const notice = '\n[Result bounded; evidence may be incomplete.]';
          const bounded =
            text.length > allowance
              ? `${text.slice(0, Math.max(0, allowance - notice.length))}${notice}`.slice(
                  0,
                  allowance,
                )
              : text;
          used = bounded.length;
          return bounded;
        } finally {
          this.remaining += allowance - used;
        }
      };
    }
    return tools;
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
    return 'Use recallFromMemory(question) when you need evidence from durable memories, skills, or older activity history. It returns a brief natural-language answer. Supporting memories and skills arrive separately as bounded context records; do not invent missing memories.';
  }

  getTools(): ToolSet {
    return {
      recallFromMemory: {
        description:
          'Ask a temporary read-only helper to recall evidence from memories, skills and retained activity history. Waits for its answer, then closes the helper.',
        inputSchema: z
          .object({ question: z.string().trim().min(1).max(12000) })
          .strict(),
        toModelOutput: ({ output }: { output: JSONValue }) => {
          const result = parseRecallAnswer(output);
          return result
            ? { type: 'text' as const, value: result.answer }
            : { type: 'json' as const, value: output };
        },
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
  ): Promise<RecallAnswer | { error: string }> {
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
    const deadline = setTimeout(exhaust, RECALL_LIMITS.hardMs);
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    this.pending.add(abort);
    let answer: RecallAnswer | undefined;
    let reader: RecallReader | undefined;
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
              (reader = new RecallReader(
                this.options,
                source,
                deps.inbox,
                (value) => {
                  answer ??= value;
                },
                abort.signal,
              )),
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
        if (reader?.finishedWithoutAnswer)
          throw new Error('Recall finalization exhausted');
        if (terminated || child.getSessionInfo().status === 'terminated')
          throw new Error('Recall helper terminated without an answer');
        const idle = await child.waitForIdle(250);
        if (idle && answer === undefined) {
          abort.signal.throwIfAborted();
          if (terminated || child.getSessionInfo().status === 'terminated')
            throw new Error('Recall helper terminated without an answer');
          reader?.continue();
        }
      }
      return answer;
    } catch (error) {
      this.deps.logger.warn({ error }, 'Memory recall failed');
      return {
        error: budgetExceeded
          ? 'Recall exceeded its time budget; no answer available. Do not retry the same question.'
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

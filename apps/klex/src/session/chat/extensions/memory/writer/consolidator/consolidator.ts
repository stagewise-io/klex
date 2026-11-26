import { randomUUID } from 'node:crypto';

import type { ActivityHistory } from '@/activity-history';
import { createContextCompactionExt } from '@/session/chat/extensions/context-compaction';
import type { ExtensionDeps } from '@/session/chat/extensions/extension-api';
import {
  field,
  joinDataBlocks,
  LINES_FORMAT_PROMPT,
  RECORD_SEPARATOR,
  renderDataBlock,
  tableField,
} from '@/session/chat/utils/history-view';
import { SessionInboxUrgency } from '@/session/inbox';
import type { ChildSessionHandle } from '@/session/types';
import type { SkillRegistry } from '@/skills';

import { childToolsExtension, settleChild } from '../child-tools';
import {
  type EntityStore,
  knownTags,
  RELATION_INVERSES,
  renderKnownTags,
} from '../entities';
import { createWriterTools } from '../tools';
import { collectChanges } from './changes';
import guidance from './guidance.md';
import {
  type ConsolidatorState,
  type ConsolidatorWrite,
  createConsolidatorState,
} from './state';
import prompt from './system-prompt.md';

export interface Consolidator {
  start(): Promise<void>;
  run(): Promise<void>;
  close(): Promise<void>;
}
export interface ConsolidatorOptions {
  deps: ExtensionDeps;
  entities: EntityStore;
  activities: ActivityHistory;
  skillReader: Pick<SkillRegistry, 'list' | 'get' | 'readReference'>;
  selfName?: () => string | undefined;
}
class ConsolidatorModule implements Consolidator {
  private state: ConsolidatorState;
  private child: ChildSessionHandle | undefined;
  private abort: AbortController | undefined;
  private closed = false;
  private starting: Promise<void> | undefined;
  constructor(private readonly options: ConsolidatorOptions) {
    this.state = createConsolidatorState(options.deps.getDataDir(true));
  }
  start(): Promise<void> {
    this.starting ??= this.state.start();
    return this.starting;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort();
    await this.child?.close();
  }
  async run(): Promise<void> {
    await this.start();
    if (this.closed) return;
    const { deps, entities, skillReader, activities } = this.options;
    const skills = deps.skills;
    if (!skills) throw new Error('Consolidator requires learned skills');
    const before = await entities.snapshot();
    const beforeSkills = skillReader.list();
    const previous = this.state.get();
    const changes = collectChanges(before, beforeSkills, previous);
    const stamp = () => [
      ...entities.list().map(
        (entity): ConsolidatorWrite => ({
          kind: 'entity',
          id: entity.id,
          writtenAt: entity.frontmatter.LastUpdatedAt,
        }),
      ),
      ...skillReader
        .list()
        .filter((skill) => skill.namespace === 'learning')
        .map(
          (skill): ConsolidatorWrite => ({
            kind: 'skill',
            id: skill.id,
            writtenAt: skill.updatedAt,
          }),
        ),
    ];
    const initial = stamp();
    if (changes.items.length) {
      this.abort = new AbortController();
      const tools = createWriterTools({
        mode: 'curation',
        entities,
        skills,
        skillReader,
        activities,
        signal: this.abort.signal,
        sourceIds: new Set(),
      }).tools;
      let completed = false;
      try {
        const child = await deps.createChildSession({
          name: 'memory-consolidator',
          extensionIdentifier: 'io.stagewise/memory-consolidator',
          basePrompt: [
            prompt.trimEnd(),
            LINES_FORMAT_PROMPT,
            renderDataBlock({
              type: 'guidance',
              fields: [field('content', guidance, 'trusted')],
            }),
          ].join('\n\n'),
          modelPurpose: 'memory',
          fallbackModelPurposes: ['chat'],
          extensions: [
            createContextCompactionExt,
            {
              identifier: 'io.stagewise/memory-consolidator-tools',
              create: () =>
                childToolsExtension(
                  () => tools,
                  (success) => {
                    completed = success;
                  },
                ),
            },
          ],
        });
        this.child = child;
        if (this.closed) return;
        child.inbox.sendMessage(
          {
            id: randomUUID(),
            role: 'user',
            parts: [
              {
                type: 'text',
                text: [
                  joinDataBlocks([
                    {
                      type: 'known-tags',
                      fields: [
                        field(
                          'tags',
                          renderKnownTags(knownTags(before)),
                          'trusted',
                        ),
                      ],
                    },
                    {
                      type: 'relationship-types',
                      fields: [
                        tableField(
                          'types',
                          ['relationship', 'inverse'],
                          Object.entries(RELATION_INVERSES).filter(
                            ([relationship, inverse], index, pairs) =>
                              !pairs
                                .slice(0, index)
                                .some(([previous]) => previous === inverse),
                          ),
                          'trusted',
                        ),
                      ],
                    },
                  ]),
                  ...changes.items.map((item) => item.text),
                ].join(RECORD_SEPARATOR),
              },
            ],
          },
          SessionInboxUrgency.Default,
        );
        await settleChild(
          child,
          'Memory consolidator',
          () => this.closed,
          () => completed,
        );
        if (this.closed) return;
      } finally {
        this.abort.abort();
        const child = this.child;
        this.child = undefined;
        await child?.close();
      }
    }
    if (this.closed) return;
    const after = stamp();
    const ownWrites = after.filter(
      (item) =>
        !initial.some(
          (old) =>
            old.kind === item.kind &&
            old.id === item.id &&
            old.writtenAt === item.writtenAt,
        ),
    );
    await this.state.update((draft) => {
      if (!changes.overflow) {
        draft.lastRunAt = new Date().toISOString();
        // Include equal-time items so millisecond ties cannot loop forever.
        draft.written = after.filter(
          (item) => item.writtenAt === draft.lastRunAt,
        );
      } else {
        draft.lastRunAt = changes.cutoff ?? previous.lastRunAt;
        draft.written = [
          ...previous.written,
          ...changes.items.map(({ kind, id, writtenAt }) => ({
            kind,
            id,
            writtenAt,
          })),
          ...ownWrites,
        ].filter(
          (item, index, all) =>
            all.findLastIndex(
              (other) => other.kind === item.kind && other.id === item.id,
            ) === index,
        );
      }
    });
  }
}
export function createConsolidator(options: ConsolidatorOptions): Consolidator {
  return new ConsolidatorModule(options);
}

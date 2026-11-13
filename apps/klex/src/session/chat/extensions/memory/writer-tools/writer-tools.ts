import { createHash } from 'node:crypto';

import type { ToolSet } from 'ai';
import { z } from 'zod';

import type { ActivityHistory, ActivityView } from '@/activity-history';
import {
  MAX_BODY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  SKILL_NAME_PATTERN,
  type SkillNamespaceHandle,
} from '@/skills';

import {
  type EntityStore,
  entityFieldsSchema,
  entityIdSchema,
  entityPatchSchema,
  entityRevision,
  type MemoryEntity,
  sectionNameSchema,
} from '../entities';

const sectionSchema = z
  .object({
    name: sectionNameSchema,
    content: z
      .string()
      .min(1)
      .max(35_000)
      .describe(
        'Section markdown without level-two headings or raw history links. Sources are appended by the tool.',
      ),
    sourceIds: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(6)
      .describe('SQLite message IDs supplied in the current activities.'),
  })
  .strict();
const editOperationSchema = z
  .object({
    op: z.enum([
      'append',
      'edit',
      'replace',
      'renameSection',
      'move',
      'removeSection',
    ]),
    section: sectionNameSchema,
    text: z
      .string()
      .max(35_000)
      .default('')
      .describe(
        'New text for append/replace/edit. Empty edit text deletes the matched passage.',
      ),
    oldText: z
      .string()
      .max(40_000)
      .default('')
      .describe(
        'Exact unique text for edit; complete source-bearing group text for move. Never include Sources lines.',
      ),
    destination: z
      .string()
      .max(100)
      .default('')
      .describe('Destination section for move or renameSection.'),
    sourceIds: z
      .array(z.string().min(1).max(4096))
      .max(6)
      .default([])
      .describe(
        'New evidence from this batch. Existing citations are retained automatically.',
      ),
    removeSourceIds: z
      .array(z.string().min(1).max(4096))
      .max(100)
      .default([])
      .describe(
        'IDs from existing history: link targets to remove (omit the history: prefix). Applies to the affected group or entire replaced section.',
      ),
    createIfMissing: z
      .boolean()
      .default(false)
      .describe('Allow append/move to create the destination section.'),
  })
  .strict();
const sourceLine = /^Sources: .*$/gm;
function contentGroups(content: string): { text: string; links: string[] }[] {
  const groups: { text: string; links: string[] }[] = [];
  let start = 0;
  for (const match of content.matchAll(sourceLine)) {
    groups.push({
      text: content.slice(start, match.index).trim(),
      links: match[0].match(/\[[^\]\n]*\]\(history:[A-Za-z0-9_-]+\)/g) ?? [],
    });
    start = match.index + match[0].length;
  }
  if (content.slice(start).trim())
    groups.push({ text: content.slice(start).trim(), links: [] });
  return groups;
}
function renderGroups(groups: { text: string; links: string[] }[]): string {
  return groups
    .filter((group) => group.text.trim())
    .map(
      (group) =>
        `${group.text.trim()}${group.links.length ? `\n\nSources: ${[...new Set(group.links)].join(' ')}` : ''}`,
    )
    .join('\n\n');
}
// Query relevance dominates. Usefulness stays neutral until real usage is recorded.
const searchWeights = {
  term: 10,
  title: 8,
  heading: 4,
  phrase: 6,
  frequency: 2,
};
function searchableText(value: string): string {
  return value
    .replace(/^Sources: .*$/gm, '')
    .replace(/\[([^\]\n]*)\]\([^)]*\)/g, '$1')
    .replace(/history:[A-Za-z0-9_-]+/g, '')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '');
}
function searchEntity(entity: MemoryEntity, query: string) {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const { Id: id, Title: title } = entity.frontmatter;
  const { entityType } = entity;
  const lines = [
    { section: 'Title', line: 1, text: title, boost: searchWeights.title },
    { section: 'Folder', line: 1, text: entityType, boost: 0 },
    ...entity.frontmatter.RelatedTo.map((relation, index) => ({
      section: 'RelatedTo',
      line: index + 1,
      text: relation.relationship,
      boost: 0,
    })),
    ...Object.entries(entity.sections).flatMap(([section, content]) => [
      { section, line: 0, text: section, boost: searchWeights.heading },
      ...searchableText(content)
        .split('\n')
        .map((text, index) => ({
          section,
          line: index + 1,
          text,
          boost: 0,
        })),
    ]),
  ].map((entry) => ({ ...entry, text: searchableText(entry.text) }));
  const matches = lines.filter(({ text }) =>
    terms.some((term) => text.toLowerCase().includes(term)),
  );
  if (terms.length && !matches.length) return null;
  const body = lines.map(({ text }) => text.toLowerCase()).join('\n');
  const score =
    terms.reduce((total, term) => {
      if (!body.includes(term)) return total;
      const occurrences = Math.min(3, body.split(term).length - 1);
      const boost = matches.reduce(
        (best, entry) =>
          entry.text.toLowerCase().includes(term)
            ? Math.max(best, entry.boost)
            : best,
        0,
      );
      return (
        total +
        searchWeights.term +
        boost +
        searchWeights.frequency * Math.log2(occurrences + 1)
      );
    }, 0) +
    (query && body.includes(query.toLowerCase()) ? searchWeights.phrase : 0);
  return {
    id,
    title,
    entityType,
    score,
    general: searchableText(entity.sections.General ?? '')
      .trim()
      .slice(0, 300),
    sections: Object.keys(entity.sections),
    matches: matches.slice(0, 5).map(({ section, line, text }) => {
      const positions = terms
        .map((term) => text.toLowerCase().indexOf(term))
        .filter((index) => index >= 0);
      const start = Math.max(0, Math.min(...positions) - 60);
      return {
        section,
        line,
        text: `${start ? '…' : ''}${text.slice(start, start + 240)}${text.length > start + 240 ? '…' : ''}`,
      };
    }),
  };
}

function skillRevision(skill: { description: string; body: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([skill.description, skill.body]))
    .digest('hex')
    .slice(0, 16);
}
const skillContent = z
  .object({
    name: z.string().regex(SKILL_NAME_PATTERN),
    description: z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH),
    body: z.string().trim().min(1).max(MAX_BODY_LENGTH),
    sourceIds: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(6)
      .describe('SQLite message IDs supplied in the current activities.'),
  })
  .strict();
export interface WriterToolsOptions {
  entities: EntityStore;
  skills: SkillNamespaceHandle;
  activities: ActivityHistory;
  signal: AbortSignal;
  sourceIds: ReadonlySet<string>;
  view?: ActivityView;
}
export interface WriterTools {
  tools: ToolSet;
}

class WriterToolsModule implements WriterTools {
  readonly tools: ToolSet;
  constructor(options: WriterToolsOptions) {
    if (options.skills.namespace !== 'learning')
      throw new Error('Writer requires learning namespace');
    const guarded =
      <T>(action: (input: T) => unknown | Promise<unknown>) =>
      async (input: T) => {
        try {
          if (options.signal.aborted) return { status: 'cancelled' };
          return await action(input);
        } catch (error) {
          return {
            status: 'rejected',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      };
    let skillWrites = Promise.resolve<unknown>(undefined);
    const skillWrite = <T>(action: (input: T) => Promise<unknown>) =>
      guarded((input: T) => {
        const result = skillWrites.then(() => {
          if (options.signal.aborted) throw new Error('Writer closed');
          return action(input);
        });
        skillWrites = result.catch(() => undefined);
        return result;
      });
    const sources = async (ids: string[]) => {
      const links: string[] = [];
      for (const id of [...new Set(ids)]) {
        if (!options.sourceIds.has(id))
          throw new Error('Source ID was not supplied in this batch');
        const page = await options.activities.readPage(id, {
          offset: 0,
          limit: 1,
          maxBytes: 2_000_000,
          view: options.view,
        });
        if (!page?.text || page.truncated)
          throw new Error('Source is unavailable or omitted');
        const label =
          `${page.startedAt ?? 'unknown date'} · ${(page.platforms ?? []).join(', ') || 'agent'}`.replace(
            /[[\]\n]/g,
            '',
          );
        links.push(`[${label}](history:${id})`);
      }
      if (options.signal.aborted) throw new Error('Writer closed');
      return links;
    };
    const sections = async (input: z.infer<typeof sectionSchema>[]) => {
      const result: Record<string, string> = Object.create(null);
      for (const section of input) {
        if (Object.hasOwn(result, section.name))
          throw new Error('Duplicate section');
        if (/history:|^##\s|^Sources:/m.test(section.content))
          throw new Error('Sources and section boundaries are tool-managed');
        result[section.name] =
          `${section.content}\n\nSources: ${(await sources(section.sourceIds)).join(' ')}`;
      }
      return result;
    };
    const checkRelations = (
      relations: z.infer<typeof entityFieldsSchema>['relatedTo'],
    ) => {
      for (const relation of relations) {
        if (
          relation.target.kind === 'entity'
            ? !options.entities.get(relation.target.id)
            : !options.skills.get(relation.target.id.slice('learning/'.length))
        )
          throw new Error('Related target does not exist');
      }
    };
    this.tools = {
      listEntities: {
        description:
          'Search title, type, every section and relation labels before creating an identity. Space-separated terms match literally, case-insensitively (any term); results are relevance-ranked with bounded General previews and matching lines. Same title may identify several entities. Generated sources and bookkeeping are excluded; no linked-entity traversal. Use readEntity for full sections.',
        inputSchema: z
          .object({
            query: z.string().max(200).default(''),
            offset: z.number().int().min(0).default(0),
          })
          .strict(),
        execute: guarded(({ query, offset }) => {
          const matches = options.entities
            .list()
            .map((entity) => searchEntity(entity, query.trim()))
            .filter((entity) => entity !== null)
            .sort(
              (a, b) =>
                b.score - a.score ||
                a.title.localeCompare(b.title) ||
                a.id.localeCompare(b.id),
            );
          return {
            entities: matches.slice(offset, offset + 20),
            nextOffset: offset + 20 < matches.length ? offset + 20 : null,
          };
        }),
      },
      readEntity: {
        description:
          'Read General plus selected detail sections. Writer reads do not update LastReadAt.',
        inputSchema: z
          .object({
            id: entityIdSchema,
            sections: z.array(sectionNameSchema).max(50).default([]),
          })
          .strict(),
        execute: guarded(({ id, sections: names }) => {
          const entity = options.entities.get(id);
          return entity
            ? {
                ...entity,
                revision: entityRevision(entity),
                sections: Object.fromEntries(
                  Object.entries(entity.sections).filter(
                    ([name]) => name === 'General' || names.includes(name),
                  ),
                ),
              }
            : { status: 'not-found' };
        }),
      },
      createEntity: {
        description:
          'Create a distinct UUID identity. General is mandatory. Tools own dates, scores, source links, filename, and the title content matcher. entityType selects a lowercase kebab-case ontology folder; new folders are allowed. Type is not stored in frontmatter.',
        inputSchema: z
          .object({
            fields: entityFieldsSchema,
            sections: z.array(sectionSchema).min(1).max(50),
          })
          .strict(),
        execute: guarded(async ({ fields, sections: input }) => {
          checkRelations(fields.relatedTo);
          const entity = await options.entities.create(
            fields,
            await sections(input),
          );
          return {
            status: 'created',
            id: entity.frontmatter.Id,
            revision: entityRevision(entity),
            sections: Object.keys(entity.sections),
          };
        }),
      },
      updateEntity: {
        description:
          'Edit an entity atomically using the revision from readEntity. Operations run in order: append adds a source-bearing group; edit replaces exactly one oldText inside one group (empty text deletes); replace rewrites a section; move transfers a complete group and its sources; renameSection renames; removeSection deletes. Existing citations survive unless explicitly removed. New facts/corrections need sourceIds. General cannot be removed or renamed. fields.entityType moves the document to that ontology folder, preserving its ID. Never include Sources lines, history links or level-two headings in text. Use readEntity after a conflict. Returns only id/revision/changed section names.',
        inputSchema: z
          .object({
            id: entityIdSchema,
            fields: entityPatchSchema,
            revision: z.string().regex(/^[a-f0-9]{16}$/),
            operations: z.array(editOperationSchema).max(50).default([]),
          })
          .strict(),
        execute: guarded(async ({ id, revision, fields, operations }) => {
          checkRelations(fields.relatedTo ?? []);
          const entity = options.entities.get(id);
          if (!entity) throw new Error('Unknown entity');
          if (entityRevision(entity) !== revision)
            throw new Error('Entity changed; read it again before editing');
          const draft: Record<string, string> = Object.assign(
            Object.create(null),
            entity.sections,
          );
          for (const operation of operations) {
            const {
              op,
              section,
              text,
              oldText,
              destination,
              sourceIds,
              removeSourceIds,
              createIfMissing,
            } = operation;
            if (
              /history:|^##\s|^Sources:/m.test(text) ||
              /history:|^Sources:/m.test(oldText)
            )
              throw new Error(
                'Sources and section boundaries are tool-managed',
              );
            const exists = Object.hasOwn(draft, section);
            if (!exists && !(op === 'append' && createIfMissing))
              throw new Error('Unknown section');
            if (op === 'renameSection' || op === 'removeSection') {
              if (section === 'General')
                throw new Error('General cannot be removed or renamed');
              if (text || oldText || sourceIds.length || removeSourceIds.length)
                throw new Error(
                  'Section rename/removal takes no text or sources',
                );
              if (op === 'renameSection') {
                sectionNameSchema.parse(destination);
                if (Object.hasOwn(draft, destination))
                  throw new Error('Destination already exists');
                draft[destination] = draft[section] ?? '';
              }
              delete draft[section];
              continue;
            }
            const groups = contentGroups(draft[section] ?? '');
            const newLinks = sourceIds.length ? await sources(sourceIds) : [];
            const availableLinks = groups.flatMap((group) => group.links);
            if (
              removeSourceIds.some(
                (id: string) =>
                  !availableLinks.some((link) =>
                    link.endsWith(`(history:${id})`),
                  ),
              )
            )
              throw new Error('Cannot remove an unknown citation');
            const retain = (links: string[]) =>
              links.filter(
                (link) =>
                  !removeSourceIds.some((source: string) =>
                    link.endsWith(`(history:${source})`),
                  ),
              );
            if (op === 'append') {
              if (
                !text.trim() ||
                !newLinks.length ||
                oldText ||
                removeSourceIds.length
              )
                throw new Error('Append requires text and new sources only');
              groups.push({ text, links: newLinks });
            } else if (op === 'replace') {
              if (oldText || destination || createIfMissing)
                throw new Error('Replace takes only text and source changes');
              if (!text.trim())
                throw new Error('Replacement must not be empty');
              const links = [
                ...retain(groups.flatMap((group) => group.links)),
                ...newLinks,
              ];
              if (!links.length)
                throw new Error('Replacement requires evidence');
              groups.splice(0, groups.length, { text, links });
            } else {
              if (!oldText) throw new Error('Exact oldText is required');
              const matches = groups.filter((group) =>
                group.text.includes(oldText),
              );
              const group = matches[0];
              if (
                matches.length !== 1 ||
                !group ||
                group.text.indexOf(oldText) !== group.text.lastIndexOf(oldText)
              )
                throw new Error(
                  'oldText must match exactly once within one source group',
                );
              if (op === 'move') {
                sectionNameSchema.parse(destination);
                if (
                  destination === section ||
                  group.text !== oldText ||
                  text ||
                  sourceIds.length ||
                  removeSourceIds.length
                )
                  throw new Error(
                    'Move requires a complete group and a different destination, without new text or sources',
                  );
                if (!Object.hasOwn(draft, destination) && !createIfMissing)
                  throw new Error('Unknown destination');
                draft[destination] = renderGroups([
                  ...contentGroups(draft[destination] ?? ''),
                  group,
                ]);
                groups.splice(groups.indexOf(group), 1);
              } else {
                group.text = group.text.replace(oldText, () => text);
                group.links = [...retain(group.links), ...newLinks];
                if (group.text.trim() && !group.links.length)
                  throw new Error('Edited content requires evidence');
              }
            }
            const rendered = renderGroups(groups);
            if (!rendered && section === 'General')
              throw new Error('General must not be empty');
            if (rendered) draft[section] = rendered;
            else delete draft[section];
          }
          if (options.signal.aborted) throw new Error('Writer closed');
          const updated = await options.entities.update(
            id,
            fields,
            draft,
            Object.keys(entity.sections).filter(
              (name) => !Object.hasOwn(draft, name),
            ),
            revision,
          );
          return {
            status: 'updated',
            id,
            revision: entityRevision(updated),
            changedSections: [
              ...new Set([
                ...Object.keys(entity.sections),
                ...Object.keys(draft),
              ]),
            ].filter((name) => entity.sections[name] !== draft[name]),
          };
        }),
      },
      listLearnedSkills: {
        description: 'List only the writer-owned learning namespace.',
        inputSchema: z.object({}).strict(),
        execute: guarded(() =>
          options.skills
            .list()
            .map(({ id, description }) => ({ id, description })),
        ),
      },
      readLearnedSkill: {
        description:
          'Read a skill using its bare name in the learning namespace.',
        inputSchema: z
          .object({ name: z.string().regex(SKILL_NAME_PATTERN) })
          .strict(),
        execute: guarded(({ name }) => {
          const skill = options.skills.get(name);
          return skill
            ? {
                ...skill,
                revision: skillRevision(skill),
              }
            : null;
        }),
      },
      createLearnedSkill: {
        description:
          'Create a reusable skill only in learning. Existing names are rejected.',
        inputSchema: skillContent,
        execute: skillWrite(async (input: z.infer<typeof skillContent>) => {
          await sources(input.sourceIds);
          if (options.skills.get(input.name))
            throw new Error('Skill already exists; update it');
          const created = await options.skills.put(
            input.name,
            { description: input.description, body: input.body },
            {
              metadata: { sourceEpisodes: input.sourceIds },
              durable: true,
            },
          );
          return {
            status: 'created',
            id: created.id,
            revision: skillRevision(created),
          };
        }),
      },
      updateLearnedSkill: {
        description:
          'Update an existing learned skill after readLearnedSkill. Body operations run in order: append new text, edit exactly one oldText (empty text deletes), replace entire body. Omit description to preserve it. All operations validate before one registry write; body must remain nonempty. Sources accumulate in metadata, not the body. No section moves or access to other namespaces.',
        inputSchema: z
          .object({
            name: skillContent.shape.name,
            revision: z.string().regex(/^[a-f0-9]{16}$/),
            description: skillContent.shape.description.optional(),
            sourceIds: skillContent.shape.sourceIds,
            operations: z
              .array(
                z
                  .object({
                    op: z.enum(['append', 'edit', 'replace']),
                    text: z.string().max(MAX_BODY_LENGTH),
                    oldText: z.string().max(MAX_BODY_LENGTH).default(''),
                  })
                  .strict(),
              )
              .max(50),
          })
          .strict(),
        execute: skillWrite(
          async (input: {
            name: string;
            revision: string;
            description?: string;
            sourceIds: string[];
            operations: {
              op: 'append' | 'edit' | 'replace';
              text: string;
              oldText: string;
            }[];
          }) => {
            await sources(input.sourceIds);
            const existing = options.skills.get(input.name);
            if (!existing) throw new Error('Unknown learned skill');
            if (skillRevision(existing) !== input.revision)
              throw new Error('Skill changed; read it again before editing');
            let body = existing.body;
            for (const operation of input.operations) {
              if (operation.op === 'edit') {
                if (
                  !operation.oldText ||
                  !body.includes(operation.oldText) ||
                  body.indexOf(operation.oldText) !==
                    body.lastIndexOf(operation.oldText)
                )
                  throw new Error('oldText must match exactly once');
                body = body.replace(operation.oldText, () => operation.text);
              } else {
                if (operation.oldText || !operation.text.trim())
                  throw new Error(
                    'Append/replace requires nonempty text and no oldText',
                  );
                body =
                  operation.op === 'append'
                    ? `${body}\n\n${operation.text}`
                    : operation.text;
              }
            }
            if (!body.trim() || body.length > MAX_BODY_LENGTH)
              throw new Error('Invalid skill body size');
            if (options.signal.aborted) throw new Error('Writer closed');
            const updated = await options.skills.put(
              input.name,
              { description: input.description ?? existing.description, body },
              {
                metadata: {
                  ...existing.metadata,
                  sourceEpisodes: [
                    ...new Set([
                      ...(Array.isArray(existing.metadata.sourceEpisodes)
                        ? existing.metadata.sourceEpisodes.filter(
                            (id): id is string => typeof id === 'string',
                          )
                        : []),
                      ...input.sourceIds,
                    ]),
                  ].slice(-20),
                },
                durable: true,
              },
            );
            return {
              status: 'updated',
              id: updated.id,
              revision: skillRevision(updated),
            };
          },
        ),
      },
    };
  }
}
export function createWriterTools(options: WriterToolsOptions): WriterTools {
  return new WriterToolsModule(options);
}

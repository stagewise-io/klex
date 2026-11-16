import { createHash } from 'node:crypto';

import type { ToolSet } from 'ai';
import { z } from 'zod';

import type { ActivityHistory, ActivityView } from '@/activity-history';
import {
  MAX_BODY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_REFERENCE_LENGTH,
  parseSkillId,
  SKILL_NAME_PATTERN,
  type SkillNamespaceHandle,
  type SkillRegistry,
} from '@/skills';

import {
  capSources,
  type EntityStore,
  entityFieldsSchema,
  entityIdSchema,
  entityPatchSchema,
  entityRevision,
  type Fact,
  type FactSource,
  factText,
  loadMatcherSchema,
  MAX_FACT_HISTORY,
  type MemoryEntity,
  sectionNameSchema,
} from '../entities';
import { rejectSecrets } from './secrets';

const sourceIdsSchema = z
  .array(z.string().min(1).max(4096))
  .max(6)
  .describe(
    'SQLite message IDs from this batch (new or previous activities) supporting the fact. Tool writes citations.',
  );
const factInputSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(1_000)
      .describe(
        'One self-contained declarative fact, one line, caveman style. No citations, headings or LinkedIdentities values.',
      ),
    sourceIds: sourceIdsSchema.min(1),
  })
  .strict();
const sectionSchema = z
  .object({
    name: sectionNameSchema.describe(
      'General, or short strongly indicative topic, e.g. Preferences, Known pitfalls.',
    ),
    facts: z.array(factInputSchema).min(1).max(40),
  })
  .strict();
const factRefSchema = z
  .string()
  .regex(/^[^#\n]+#[1-9][0-9]*$/)
  .describe('Fact address from latest readEntity, e.g. General#2.');
const operationSchema = z
  .object({
    op: z
      .enum([
        'add',
        'supersede',
        'reword',
        'merge',
        'restore',
        'move',
        'remove',
        'renameSection',
      ])
      .describe(
        'add: new fact in section. supersede: new evidence replaces fact; old kept as was:. reword: same meaning, clearer/shorter. merge: facts (same section) into one. restore: was: version becomes current again. move: fact to destination section. remove: duplicate or noise only. renameSection: section to destination. Empty sections vanish.',
      ),
    section: sectionNameSchema
      .optional()
      .describe('Section for add and renameSection.'),
    fact: factRefSchema
      .optional()
      .describe('Target for supersede, reword, restore, move, remove.'),
    facts: z
      .array(factRefSchema)
      .max(10)
      .default([])
      .describe('Facts to merge, at least two.'),
    text: z
      .string()
      .max(1_000)
      .default('')
      .describe('New fact text for add, supersede, reword, merge.'),
    version: z
      .number()
      .int()
      .min(1)
      .max(MAX_FACT_HISTORY)
      .optional()
      .describe('was: version to restore, 1 = newest.'),
    destination: z
      .string()
      .max(100)
      .default('')
      .describe('Target section for move/renameSection; created if missing.'),
    sourceIds: sourceIdsSchema
      .default([])
      .describe(
        'Batch evidence. Required for add, supersede, restore; optional for reword/merge.',
      ),
  })
  .strict();
type Operation = z.infer<typeof operationSchema>;

// Shape limits for writer output; sizes count current fact text only.
const SHAPE = {
  detailSections: 4,
  general: 600,
  section: 3_000,
  facts: 40,
  pattern: 60,
};
const sectionSize = (facts: readonly Fact[]) =>
  facts.reduce((total, fact) => total + fact.text.length + 2, 0);
function checkShape(
  sections: Record<string, Fact[]>,
  changed: readonly string[],
  loadOn: readonly { type: string; pattern?: string }[] = [],
  identities: readonly { match: Record<string, string> }[] = [],
  previousCount = 0,
): void {
  const count = Object.keys(sections).length;
  if (count > SHAPE.detailSections + 1 && count > previousCount)
    throw new Error(
      `Max ${SHAPE.detailSections} sections besides General; merge into existing sections`,
    );
  const ids = identities
    .flatMap((identity) => Object.values(identity.match))
    .filter((value) => value.length >= 4);
  for (const name of changed) {
    const facts = sections[name];
    if (!facts) continue;
    const limit = name === 'General' ? SHAPE.general : SHAPE.section;
    if (sectionSize(facts) > limit)
      throw new Error(
        `${name} exceeds ${limit} characters; merge, reword or drop low-value facts${name === 'General' ? ', or move situational detail to a section' : ''}`,
      );
    if (facts.length > SHAPE.facts)
      throw new Error(`${name} exceeds ${SHAPE.facts} facts; merge facts`);
    for (const fact of facts) {
      const id = ids.find((value) => fact.text.includes(value));
      if (id)
        throw new Error(
          `Fact repeats linked identity value "${id}"; IDs live in LinkedIdentities only`,
        );
    }
  }
  for (const matcher of loadOn)
    if (
      matcher.type === 'contentPattern' &&
      (matcher.pattern?.length ?? 0) > SHAPE.pattern
    )
      throw new Error(
        `contentPattern "${matcher.pattern}" exceeds ${SHAPE.pattern} characters; use a short verbatim token`,
      );
}

function uniqueMatchers<T>(matchers: readonly T[]): T[] {
  const seen = new Set<string>();
  return matchers.filter((matcher) => {
    const key = JSON.stringify(matcher);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Writer view: addressed current facts and superseded versions, no citations. */
function writerSections(
  entity: MemoryEntity,
  names: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entity.sections)
      .filter(([name]) => name === 'General' || names.includes(name))
      .map(([name, facts]) => [
        name,
        facts
          .flatMap((fact, index) => [
            `[${name}#${index + 1}] ${fact.text}`,
            ...fact.history.map(
              (version, offset) => `  was ${offset + 1}: ${version.text}`,
            ),
          ])
          .join('\n'),
      ]),
  );
}

// Query relevance dominates. Usefulness stays neutral until real usage is recorded.
const searchWeights = {
  term: 10,
  title: 8,
  heading: 4,
  phrase: 6,
  frequency: 2,
};
const searchableText = (value: string) =>
  value.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '');
function searchEntity(entity: MemoryEntity, query: string) {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const { id, entityType } = entity;
  const title = entity.frontmatter.Title;
  const lines = [
    { section: 'Title', line: 1, text: title, boost: searchWeights.title },
    { section: 'Folder', line: 1, text: entityType, boost: 0 },
    ...entity.frontmatter.RelatedTo.map((relation, index) => ({
      section: 'RelatedTo',
      line: index + 1,
      text: relation.relationship,
      boost: 0,
    })),
    ...Object.entries(entity.sections).flatMap(([section, facts]) => [
      { section, line: 0, text: section, boost: searchWeights.heading },
      ...facts.map((fact, index) => ({
        section,
        line: index + 1,
        text: fact.text,
        boost: 0,
      })),
    ]),
  ].map((entry) => ({ ...entry, text: searchableText(entry.text) }));
  const matches = lines.filter(({ text }) =>
    terms.some((term) => text.toLowerCase().includes(term)),
  );
  if (terms.length && !matches.length) return null;
  const general = (entity.sections.General ?? [])
    .map((fact) => fact.text)
    .join('; ')
    .slice(0, 300);
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
    general,
    sections: Object.keys(entity.sections),
    // Title, type and visible General text are already in the result.
    matches: matches
      .filter(
        ({ section, text }) =>
          section !== 'Title' &&
          section !== 'Folder' &&
          !(section === 'General' && general.includes(text)),
      )
      .slice(0, 5)
      .map(({ section, line, text }) => {
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
const referenceNameSchema = z
  .string()
  .regex(SKILL_NAME_PATTERN)
  .describe('Reference file name, kebab-case, without .md.');
// Stored in the learning namespace's registry metadata, next to provenance.
const skillLoadOnSchema = z
  .array(loadMatcherSchema)
  // Registry metadata is capped at MAX_METADATA_BYTES, shared with provenance.
  .max(8)
  .describe(
    'Auto-load triggers, any one fires: event or tool call where this procedure applies. Same matcher rules as entities.',
  );
const skillContent = z
  .object({
    name: z
      .string()
      .regex(SKILL_NAME_PATTERN)
      .describe('Bare skill name, without learning/ prefix.'),
    description: z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH),
    body: z
      .string()
      .trim()
      .min(1)
      .max(MAX_BODY_LENGTH)
      .describe('Plain Markdown. Provenance stays in metadata, not body.'),
    sourceIds: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(6)
      .describe(
        'Actual SQLite message IDs from new or previous activities in this batch. Tool stores provenance; do not put source links in text.',
      ),
    loadOn: skillLoadOnSchema.default([]),
  })
  .strict();
export interface WriterToolsOptions {
  entities: EntityStore;
  skills: SkillNamespaceHandle;
  skillReader: Pick<SkillRegistry, 'list' | 'get' | 'readReference'>;
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
    // Instance suffixes (`machine-<uuid>`) cost tokens on every citation.
    const sourceLabel = (platforms: string[] = []) =>
      [
        ...new Set(
          platforms.map((platform) =>
            platform.replace(
              /-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
              '',
            ),
          ),
        ),
      ].join(', ') || 'agent';
    const sources = async (ids: string[]): Promise<FactSource[]> => {
      const result: FactSource[] = [];
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
        result.push({
          label: `${page.startedAt?.slice(0, 10) || 'unknown date'} · ${sourceLabel(page.platforms)}`,
          id,
        });
      }
      if (options.signal.aborted) throw new Error('Writer closed');
      return result;
    };
    const evidence = async (ids: string[]) => {
      if (!ids.length) throw new Error('This operation requires sourceIds');
      return sources(ids);
    };
    const sections = async (input: z.infer<typeof sectionSchema>[]) => {
      const result: Record<string, Fact[]> = Object.create(null);
      for (const section of input) {
        if (Object.hasOwn(result, section.name))
          throw new Error('Duplicate section');
        const facts: Fact[] = [];
        for (const fact of section.facts)
          facts.push({
            text: factText(fact.text),
            sources: await evidence(fact.sourceIds),
            history: [],
          });
        result[section.name] = facts;
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
            : !options.skillReader.get(relation.target.id)
        )
          throw new Error(
            `Invalid reference: ${relation.target.kind} "${relation.target.id}" does not exist`,
          );
      }
    };
    this.tools = {
      listEntities: {
        description:
          'Find entities. Search before create; same title can mean different identities.',
        inputSchema: z
          .object({
            query: z
              .string()
              .max(200)
              .default('')
              .describe(
                'Literal terms, case-insensitive, any term matches. Empty lists all. Searches title, type, facts and relation labels.',
              ),
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
            entities: matches
              .slice(offset, offset + 20)
              .map(({ score: _score, ...entity }) => entity),
            nextOffset: offset + 20 < matches.length ? offset + 20 : null,
          };
        }),
      },
      readEntity: {
        description:
          'Read addressed facts (with was: versions), identities, matchers, relations, revision. Use before edit; reread on conflict.',
        inputSchema: z
          .object({
            id: entityIdSchema,
            sections: z
              .array(sectionNameSchema)
              .max(50)
              .default([])
              .describe(
                'Detail sections to include; General is always returned.',
              ),
          })
          .strict(),
        execute: guarded(({ id, sections: names }) => {
          const entity = options.entities.get(id);
          if (!entity) return { status: 'not-found' };
          const { Title, LinkedIdentities, LoadOn, RelatedTo } =
            entity.frontmatter;
          return {
            id,
            title: Title,
            entityType: entity.entityType,
            linkedIdentities: LinkedIdentities,
            loadOn: LoadOn,
            relatedTo: RelatedTo,
            revision: entityRevision(entity),
            sections: writerSections(entity, names),
            otherSections: Object.keys(entity.sections).filter(
              (name) => name !== 'General' && !names.includes(name),
            ),
          };
        }),
      },
      createEntity: {
        description:
          'Create new identity when no match exists. Facts only, no instructions. Need General and sources.',
        inputSchema: z
          .object({
            fields: entityFieldsSchema,
            sections: z.array(sectionSchema).min(1).max(5),
          })
          .strict(),
        execute: guarded(async ({ fields, sections: input }) => {
          rejectSecrets(
            [fields, input],
            (input as z.infer<typeof sectionSchema>[]).flatMap((section) =>
              section.facts.map(({ text }) => text),
            ),
          );
          const content = await sections(input);
          checkShape(
            content,
            Object.keys(content),
            fields.loadOn,
            fields.linkedIdentities,
          );
          checkRelations(fields.relatedTo);
          const entity = await options.entities.create(fields, content);
          return {
            status: 'created',
            id: entity.id,
            revision: entityRevision(entity),
            sections: Object.keys(entity.sections),
          };
        }),
      },
      updateEntity: {
        description:
          'Change existing entity. Read first; address facts as Section#n from that read. Supersede stale facts, never delete history. Ordered operations commit together.',
        inputSchema: z
          .object({
            id: entityIdSchema,
            fields: entityPatchSchema,
            revision: z
              .string()
              .regex(/^[a-f0-9]{16}$/)
              .describe('Revision from latest read. Conflict: read again.'),
            operations: z.array(operationSchema).max(50).default([]),
          })
          .strict(),
        execute: guarded(async ({ id, revision, fields, operations }) => {
          rejectSecrets(
            [fields, operations],
            (operations as { text: string }[]).map(({ text }) => text),
          );
          const entity = options.entities.get(id);
          if (!entity) throw new Error('Unknown entity');
          if (entityRevision(entity) !== revision)
            throw new Error('Entity changed; read it again before editing');
          const draft: Record<string, Fact[]> = Object.assign(
            Object.create(null),
            structuredClone(entity.sections),
          );
          // Addresses refer to the state that was read, so they stay stable
          // while earlier operations in the same call reorder facts.
          const addressed = new Map<string, Fact>();
          for (const [name, facts] of Object.entries(draft))
            facts.forEach((fact, index) => {
              addressed.set(`${name}#${index + 1}`, fact);
            });
          const changed = new Set<string>();
          const locate = (ref: string | undefined) => {
            const fact = ref ? addressed.get(ref) : undefined;
            if (!fact) throw new Error(`Unknown fact ${ref ?? '(missing)'}`);
            const section = Object.keys(draft).find((name) =>
              draft[name]?.includes(fact),
            );
            if (!section) throw new Error(`Fact ${ref} was already removed`);
            return { fact, section };
          };
          const detach = (fact: Fact, section: string) => {
            const facts = draft[section] ?? [];
            facts.splice(facts.indexOf(fact), 1);
            changed.add(section);
          };
          const attach = (fact: Fact, section: string) => {
            sectionNameSchema.parse(section);
            draft[section] ??= [];
            draft[section].push(fact);
            changed.add(section);
          };
          const apply = async (operation: Operation) => {
            const { op, text, sourceIds, destination } = operation;
            if (op === 'add') {
              if (!operation.section) throw new Error('add requires section');
              attach(
                {
                  text: factText(text),
                  sources: await evidence(sourceIds),
                  history: [],
                },
                operation.section,
              );
            } else if (op === 'renameSection') {
              const from = operation.section;
              if (!from || !Object.hasOwn(draft, from))
                throw new Error('Unknown section');
              if (from === 'General' || destination === 'General')
                throw new Error('General cannot be renamed');
              sectionNameSchema.parse(destination);
              if (Object.hasOwn(draft, destination))
                throw new Error('Destination already exists');
              draft[destination] = draft[from] ?? [];
              delete draft[from];
              changed.add(destination);
            } else if (op === 'merge') {
              const targets = [...new Set(operation.facts)].map(locate);
              const [first, ...rest] = targets;
              if (!first || !rest.length)
                throw new Error('merge requires at least two facts');
              if (targets.some(({ section }) => section !== first.section))
                throw new Error('merge requires facts in one section');
              const added = sourceIds.length ? await sources(sourceIds) : [];
              first.fact.text = factText(text);
              first.fact.sources = capSources([
                ...targets.flatMap(({ fact }) => fact.sources),
                ...added,
              ]);
              first.fact.history = targets
                .flatMap(({ fact }) => fact.history)
                .slice(0, MAX_FACT_HISTORY);
              for (const { fact, section } of rest) detach(fact, section);
              changed.add(first.section);
            } else {
              const { fact, section } = locate(operation.fact);
              changed.add(section);
              if (op === 'supersede') {
                const added = await evidence(sourceIds);
                fact.history = [
                  { text: fact.text, sources: fact.sources },
                  ...fact.history,
                ].slice(0, MAX_FACT_HISTORY);
                fact.text = factText(text);
                fact.sources = added;
              } else if (op === 'reword') {
                const added = sourceIds.length ? await sources(sourceIds) : [];
                fact.text = factText(text);
                fact.sources = capSources([...fact.sources, ...added]);
              } else if (op === 'restore') {
                const index = (operation.version ?? 0) - 1;
                const version = fact.history[index];
                if (!version) throw new Error('Unknown was: version');
                const added = await evidence(sourceIds);
                fact.history.splice(index, 1);
                fact.history.unshift({
                  text: fact.text,
                  sources: fact.sources,
                });
                fact.text = version.text;
                fact.sources = capSources([...version.sources, ...added]);
              } else if (op === 'move') {
                if (!destination || destination === section)
                  throw new Error('move requires a different destination');
                detach(fact, section);
                attach(fact, destination);
              } else {
                detach(fact, section);
              }
            }
          };
          for (const operation of operations) await apply(operation);
          for (const name of Object.keys(draft))
            if (!draft[name]?.length) delete draft[name];
          if (!draft.General?.length)
            throw new Error('General must keep at least one fact');
          if (options.signal.aborted) throw new Error('Writer closed');
          checkShape(
            draft,
            [...changed],
            fields.loadOn,
            fields.linkedIdentities ?? entity.frontmatter.LinkedIdentities,
            Object.keys(entity.sections).length,
          );
          checkRelations(fields.relatedTo ?? entity.frontmatter.RelatedTo);
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
            changedSections: [...changed].filter((name) =>
              Object.hasOwn(draft, name),
            ),
          };
        }),
      },
      listSkills: {
        description:
          'Find skills, all namespaces. Check before create or update.',
        inputSchema: z.object({}).strict(),
        execute: guarded(() =>
          options.skillReader
            .list()
            .map(({ id, description }) => ({ id, description })),
        ),
      },
      readSkill: {
        description:
          'Read skill, revision and reference names by namespace/name. With reference: that file. Use before edit or reuse.',
        inputSchema: z
          .object({
            id: z
              .string()
              .refine(
                (id) => parseSkillId(id) !== null,
                'Expected namespace/name',
              ),
            reference: referenceNameSchema.optional(),
          })
          .strict(),
        execute: guarded(({ id, reference }) => {
          const skill = options.skillReader.get(id);
          if (!skill) return null;
          if (reference === undefined)
            return { ...skill, revision: skillRevision(skill) };
          const content = options.skillReader.readReference(id, reference);
          if (content === null) throw new Error('Unknown reference');
          return { id, reference, content };
        }),
      },
      writeSkillReference: {
        description:
          'Create or replace reference file of learning skill: long examples, schemas, edge cases loaded only when needed. Skill body must name it and say when to load it.',
        inputSchema: z
          .object({
            name: skillContent.shape.name,
            reference: referenceNameSchema,
            content: z
              .string()
              .trim()
              .min(1)
              .max(MAX_REFERENCE_LENGTH)
              .describe('Plain Markdown.'),
            sourceIds: skillContent.shape.sourceIds,
          })
          .strict(),
        execute: skillWrite(
          async (input: {
            name: string;
            reference: string;
            content: string;
            sourceIds: string[];
          }) => {
            rejectSecrets(input, [input.content]);
            await sources(input.sourceIds);
            const skill = await options.skills.putReference(
              input.name,
              input.reference,
              input.content,
            );
            if (!skill) throw new Error('Unknown learned skill');
            return {
              status: 'written',
              id: skill.id,
              references: skill.references,
              revision: skillRevision(skill),
            };
          },
        ),
      },
      deleteSkillReference: {
        description: 'Delete obsolete reference file of learning skill.',
        inputSchema: z
          .object({
            name: skillContent.shape.name,
            reference: referenceNameSchema,
          })
          .strict(),
        execute: skillWrite(
          async (input: { name: string; reference: string }) => {
            if (!options.skills.get(input.name))
              throw new Error('Unknown learned skill');
            if (
              !(await options.skills.deleteReference(
                input.name,
                input.reference,
              ))
            )
              throw new Error('Unknown reference');
            return { status: 'deleted' };
          },
        ),
      },
      deleteLearnedSkill: {
        description:
          'Delete disproven, obsolete or duplicate learning skill, with its references. Fails while an entity relates to it.',
        inputSchema: z
          .object({
            name: skillContent.shape.name,
            revision: z
              .string()
              .regex(/^[a-f0-9]{16}$/)
              .describe('Revision from latest read.'),
          })
          .strict(),
        execute: skillWrite(
          async (input: { name: string; revision: string }) => {
            const existing = options.skills.get(input.name);
            if (!existing) throw new Error('Unknown learned skill');
            if (skillRevision(existing) !== input.revision)
              throw new Error('Skill changed; read it again before deleting');
            await options.skills.delete(input.name);
            return { status: 'deleted', id: existing.id };
          },
        ),
      },
      createLearnedSkill: {
        description:
          'Create learning skill. Use when no existing skill fits. Bare name; need sources.',
        inputSchema: skillContent,
        execute: skillWrite(async (input: z.infer<typeof skillContent>) => {
          rejectSecrets(input, [input.description, input.body]);
          checkShape(Object.create(null), [], input.loadOn);
          await sources(input.sourceIds);
          if (options.skills.get(input.name))
            throw new Error('Skill already exists; update it');
          const created = await options.skills.put(
            input.name,
            { description: input.description, body: input.body },
            {
              metadata: {
                sourceEpisodes: input.sourceIds,
                loadOn: uniqueMatchers(input.loadOn),
              },
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
          'Improve learning skill. Read first. Bare name; ordered edits commit together. Need sources.',
        inputSchema: z
          .object({
            name: skillContent.shape.name,
            revision: z
              .string()
              .regex(/^[a-f0-9]{16}$/)
              .describe('Revision from latest read. Conflict: read again.'),
            description: skillContent.shape.description
              .optional()
              .describe('Omit to keep existing description.'),
            sourceIds: skillContent.shape.sourceIds,
            loadOn: skillLoadOnSchema
              .optional()
              .describe('Replaces all triggers. Omit to keep.'),
            operations: z
              .array(
                z
                  .object({
                    op: z
                      .enum(['append', 'edit', 'replace'])
                      .describe(
                        'append: add text; edit: change exact unique oldText, empty text deletes; replace: rewrite whole body. Body must stay nonempty.',
                      ),
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
            loadOn?: z.infer<typeof skillLoadOnSchema>;
            operations: {
              op: 'append' | 'edit' | 'replace';
              text: string;
              oldText: string;
            }[];
          }) => {
            rejectSecrets(input, [
              input.description ?? '',
              ...input.operations.map(({ text }) => text),
            ]);
            checkShape(Object.create(null), [], input.loadOn);
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
                  ...(input.loadOn
                    ? { loadOn: uniqueMatchers(input.loadOn) }
                    : {}),
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

import { createHash } from 'node:crypto';

import type { JSONSchema7 } from '@ai-sdk/provider';
import { asSchema, jsonSchema, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ActivityHistory, ActivityView } from '@/activity-history';
import {
  field,
  formatMemory,
  formatSkill,
} from '@/session/chat/extensions/memory/loading';
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
  mergedEntity,
  RELATION_INVERSES,
  type Relation,
  relationSchema,
  sectionNameSchema,
} from '../entities';
import {
  checkCopied,
  checkFact,
  checkSkill,
  checkSkillWhen,
  copiedValues,
  MAX_WRITER_FACT,
  parseSkillBody,
  renderSkillBody,
  type StructuredSkill,
  similarSkills,
} from './quality';
import { rejectSecrets } from './secrets';

// Providers receive structure and exact choices only. The original validator
// remains authoritative, including defaults, transforms and detailed constraints.
function providerSchema(schema: JSONSchema7): JSONSchema7 {
  if (schema.$ref !== undefined)
    throw new Error(
      'Memory writer schemas must be inlined before provider export',
    );
  const result: JSONSchema7 = {};
  for (const key of [
    'type',
    'enum',
    'const',
    'description',
    'required',
  ] as const) {
    if (schema[key] !== undefined)
      Object.assign(result, { [key]: schema[key] });
  }
  for (const key of ['properties', 'definitions', '$defs'] as const) {
    const children = schema[key];
    if (children && typeof children === 'object') {
      Object.assign(result, {
        [key]: Object.fromEntries(
          Object.entries(children).map(([name, child]) => [
            name,
            typeof child === 'boolean'
              ? child
              : providerSchema(child as JSONSchema7),
          ]),
        ),
      });
    }
  }
  for (const key of ['additionalProperties', 'items'] as const) {
    const child = schema[key];
    if (child !== undefined)
      Object.assign(result, {
        [key]:
          typeof child === 'boolean'
            ? child
            : Array.isArray(child)
              ? child.map((item) =>
                  typeof item === 'boolean' ? item : providerSchema(item),
                )
              : providerSchema(child),
      });
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const children = schema[key];
    if (children)
      result[key] = children.map((child) =>
        typeof child === 'boolean' ? child : providerSchema(child),
      );
  }
  return result;
}

// Fixed inverses are maintained automatically; callers cannot invent labels.
const writerRelationSchema = relationSchema;
type WriterRelation = z.infer<typeof writerRelationSchema>;
const writerFieldsSchema = entityFieldsSchema.extend({
  relatedTo: z.array(writerRelationSchema).max(100).default([]),
});
const writerPatchSchema = entityPatchSchema.extend({
  relatedTo: z.array(writerRelationSchema).max(100).optional(),
});
/** Resolve case-insensitive lookups to the exact stored path. */
const canonical = (
  entities: EntityStore,
  relations: readonly WriterRelation[],
): WriterRelation[] =>
  relations.map((relation) =>
    relation.target.kind === 'entity'
      ? {
          ...relation,
          target: {
            kind: 'entity',
            id: entities.get(relation.target.id)?.id ?? relation.target.id,
          },
        }
      : relation,
  );
// Literal folder tags from flattened notes (`person`, `bot`, …) count alongside
// default ontology tags (`people`, `work-items/issues`, …).
const PEOPLE = new Set(['people', 'teams', 'person', 'bot', 'team']);
const WORK_ITEMS = new Set(['work-items', 'issue', 'pull-request']);
const EVENTS = new Set(['events', 'event']);
const PERSONS = new Set(['people', 'person', 'bot']);
/** A tag matches when it, or any ancestor (`a`, `a/b` of `a/b/c`), is one of `kinds`. */
const tagged = (tags: readonly string[], kinds: ReadonlySet<string>) =>
  tags.some((tag) => {
    const segments = tag.split('/');
    return segments.some((_, index) =>
      kinds.has(segments.slice(0, index + 1).join('/')),
    );
  });

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
      .max(MAX_WRITER_FACT * 2)
      .describe(
        'One fact, one line, caveman style, without the subject. No citations or IDs.',
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
// Curation has no batch: new facts must name the existing facts they derive from.
const curationOperationSchema = operationSchema.extend({
  sourceIds: z
    .array(z.string())
    .max(0)
    .default([])
    .describe('Always empty: curation inherits sources.'),
  fromFacts: z
    .array(
      z
        .object({
          entity: entityIdSchema,
          fact: factRefSchema,
        })
        .strict(),
    )
    .max(10)
    .default([])
    .describe(
      'Required for add: current facts (this or other entities, from latest reads) the new fact restates; their sources are copied.',
    ),
});
type Operation = z.infer<typeof operationSchema> & {
  fromFacts?: { entity: string; fact: string }[];
};

/** Tools of a curation session: no creation, no new evidence. */
export const CURATION_TOOLS = [
  'listEntities',
  'readEntity',
  'updateEntity',
  'mergeEntities',
  'listSkills',
  'readSkill',
  'updateLearnedSkill',
  'deleteLearnedSkill',
  'deleteSkillReference',
] as const;

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
  const { id } = entity;
  const title = id;
  const tags = entity.frontmatter.Tags;
  const lines = [
    { section: 'Title', line: 1, text: title, boost: searchWeights.title },
    { section: 'Tags', line: 1, text: tags.join(' '), boost: 0 },
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
    tags,
    score,
    general,
    sections: Object.keys(entity.sections),
    // Title, tags and visible General text are already in the result.
    matches: matches
      .filter(
        ({ section, text }) =>
          section !== 'Title' &&
          section !== 'Tags' &&
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

/** Exactly what readEntity returns; General is always included. */
export function entityReadResult(
  entity: MemoryEntity,
  names: readonly string[],
): string {
  const { LinkedIdentities, LoadOn, RelatedTo, Tags } = entity.frontmatter;
  const sections = writerSections(entity, names);
  return [
    formatMemory(
      {
        version: 1,
        kind: 'entity',
        title: entity.id,
        tags: Tags,
        linkedIdentities: LinkedIdentities,
        sections: Object.keys(entity.sections).filter(
          (name) => name !== 'General',
        ),
        body: sections.General ?? '',
      },
      `${entity.id}.md`,
      false,
      [
        field('revision', entityRevision(entity)),
        field('loadOn', JSON.stringify(LoadOn)),
        field('relatedTo', JSON.stringify(RelatedTo)),
      ],
    ),
    ...Object.entries(sections)
      .filter(([name]) => name !== 'General')
      .map(([section, body]) =>
        formatMemory(
          {
            version: 1,
            kind: 'detail',
            title: entity.id,
            section,
            sections: [],
            body,
          },
          `${entity.id}.md`,
        ),
      ),
  ].join('\n\n');
}

/** Exactly what readSkill returns without a reference. */
export function skillReadResult(
  skill: NonNullable<ReturnType<SkillRegistry['get']>>,
): string {
  return formatSkill(
    {
      title: skill.id,
      description: skill.description,
      body: skill.body,
      references: skill.references,
    },
    {
      referenceTool: 'readSkill',
      extra: [
        field('revision', skillRevision(skill)),
        field('loadOn', JSON.stringify(skill.metadata.loadOn ?? [])),
      ],
    },
  );
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
const item = (max: number, hint: string) =>
  z.string().trim().min(3).max(max).describe(hint);
const skillParts = {
  when: z
    .string()
    .trim()
    .min(10)
    .max(150)
    .describe(
      'Skill description: one or two short positive sentences on when it applies and what for. No steps, no exclusions. e.g. "Opening a GitHub PR from a sandbox. Gets branch, push and PR call right."',
    ),
  steps: z
    .array(
      item(
        120,
        'Imperative, caveman. e.g. "Push head branch before create_pull_request".',
      ),
    )
    .min(1)
    .max(8),
  pitfalls: z
    .array(
      item(
        140,
        'Proven failure → fix. e.g. "422 head invalid: branch not pushed".',
      ),
    )
    .max(5),
  verify: z
    .string()
    .trim()
    .max(120)
    .describe(
      'One concrete success check, not a repeated step. Empty if none.',
    ),
};
const skillCreateSchema = z
  .object({
    name: z
      .string()
      .regex(SKILL_NAME_PATTERN)
      .describe('Bare kebab-case name, without learning/ prefix.'),
    when: skillParts.when,
    steps: skillParts.steps,
    pitfalls: skillParts.pitfalls.default([]),
    verify: skillParts.verify.default(''),
    sourceIds: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(6)
      .describe('SQLite message IDs from this batch.'),
    loadOn: skillLoadOnSchema.default([]),
    notDuplicateOf: z
      .array(z.string())
      .max(10)
      .default([])
      .describe('Only after a Similar rejection: ids you checked that differ.'),
  })
  .strict();
const skillUpdateSchema = z
  .object({
    name: skillCreateSchema.shape.name,
    revision: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .describe('Revision from latest read. Conflict: read again.'),
    when: skillParts.when.optional(),
    steps: skillParts.steps.optional(),
    pitfalls: skillParts.pitfalls.optional(),
    verify: skillParts.verify.optional(),
    sourceIds: skillCreateSchema.shape.sourceIds,
    loadOn: skillLoadOnSchema
      .optional()
      .describe('Replaces all triggers. Omit to keep.'),
  })
  .strict();
const structured = (input: {
  steps: string[];
  pitfalls: string[];
  verify: string;
}): StructuredSkill => ({
  steps: input.steps,
  pitfalls: input.pitfalls,
  verify: input.verify,
});
const skillTexts = (skill: StructuredSkill) => [
  ...skill.steps,
  ...skill.pitfalls,
  skill.verify,
];
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
  /** The bot itself; never an entity. */
  selfName?: string;
  /** Batch text; identity and matcher values must be copied from it. */
  evidenceText?: string;
  /**
   * `curation`: maintenance without a batch. Only `CURATION_TOOLS`; facts
   * inherit sources of the facts they replace or restate. Default `writer`.
   */
  mode?: 'writer' | 'curation';
}
export interface WriterTools {
  tools: ToolSet;
}

class WriterToolsModule implements WriterTools {
  readonly tools: ToolSet;
  constructor(options: WriterToolsOptions) {
    if (options.skills.namespace !== 'learning')
      throw new Error('Writer requires learning namespace');
    const curation = options.mode === 'curation';
    const stable = (value: unknown): string =>
      JSON.stringify(value, (_key, child) =>
        child && typeof child === 'object' && !Array.isArray(child)
          ? Object.fromEntries(
              Object.entries(child).sort(([a], [b]) => a.localeCompare(b)),
            )
          : child,
      );
    const existingIdentities = new Set(
      options.entities
        .list()
        .flatMap((entity) => entity.frontmatter.LinkedIdentities.map(stable)),
    );
    const existingMatchers = new Set(
      [
        ...options.entities
          .list()
          .flatMap((entity) => entity.frontmatter.LoadOn),
        ...options.skillReader
          .list()
          .flatMap((skill) =>
            Array.isArray(skill.metadata.loadOn) ? skill.metadata.loadOn : [],
          ),
      ].map(stable),
    );
    const checkExisting = (
      identities: readonly unknown[] = [],
      matchers: readonly unknown[] = [],
    ) => {
      if (!curation) return;
      if (
        identities.some((identity) => !existingIdentities.has(stable(identity)))
      )
        throw new Error('Curation may only reuse existing LinkedIdentities');
      if (matchers.some((matcher) => !existingMatchers.has(stable(matcher))))
        throw new Error('Curation may only reuse existing LoadOn triggers');
    };
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
        const label = `${page.startedAt?.slice(0, 10) || 'unknown date'} · ${sourceLabel(page.platforms)}`;
        // One citation per day and platform: more add bytes, not evidence.
        if (!result.some((source) => source.label === label))
          result.push({ label, id });
      }
      if (options.signal.aborted) throw new Error('Writer closed');
      return result;
    };
    const evidence = async (ids: string[]) => {
      if (!ids.length) throw new Error('This operation requires sourceIds');
      return sources(ids);
    };
    /** Curation: sources of current facts, addressed per entity. */
    const inherited = (refs: readonly { entity: string; fact: string }[]) => {
      if (!refs.length)
        throw new Error(
          'add requires fromFacts: the existing facts this one restates',
        );
      return capSources(
        refs.flatMap(({ entity: id, fact: ref }) => {
          const entity = options.entities.get(id);
          if (!entity) throw new Error(`Unknown entity ${id}`);
          const [name = '', index = ''] = ref.split('#');
          const fact = entity.sections[name]?.[Number(index) - 1];
          if (!fact) throw new Error(`Unknown fact ${id} ${ref}`);
          return fact.sources;
        }),
      );
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
    const tagsOf = (id: string) => options.entities.get(id)?.frontmatter.Tags;
    /** Shape rules code can check; messages name the fix. */
    const checkEntity = (
      title: string,
      tags: readonly string[],
      relations: readonly { target: { kind: string; id: string } }[],
      facts: readonly string[],
      copied: { identities: string[]; matchers: string[] },
    ) => {
      const self = options.selfName?.toLowerCase();
      if (self && title.trim().toLowerCase() === self)
        throw new Error(
          `"${title}" is self. Never create or edit an entity for self; put facts on the people and things self works with`,
        );
      for (const fact of facts) checkFact(fact, title, tagged(tags, PERSONS));
      const evidence = options.evidenceText;
      if (!curation && evidence !== undefined) {
        checkCopied(copied.identities, evidence, 'Identity value');
        checkCopied(copied.matchers, evidence, 'LoadOn value');
      }
      const people = relations.filter(
        ({ target }) =>
          target.kind === 'entity' && tagged(tagsOf(target.id) ?? [], PEOPLE),
      ).length;
      if (tagged(tags, WORK_ITEMS) && people < 1)
        throw new Error(
          'Link who requested, owns or is assigned it: add a relatedTo person, e.g. relationship "requestedBy", "ownedBy" or "assignedTo". Inverse is automatic. Create the person first if missing',
        );
      if (tagged(tags, EVENTS) && people < 2)
        throw new Error(
          'An event links everyone involved: add at least two relatedTo people using a curated predicate, or "relatedTo" when none fits',
        );
    };
    /** Writes or removes the reverse side of entity relations of `id`. */
    const syncInverses = async (
      id: string,
      next: readonly WriterRelation[],
      previous: readonly Relation[],
    ) => {
      const targets = new Set(
        [...next, ...previous]
          .filter(({ target }) => target.kind === 'entity')
          .map(({ target }) => target.id),
      );
      // Preflight: every target must exist before anything is written.
      for (const targetId of targets)
        if (targetId !== id && !options.entities.get(targetId))
          throw new Error(
            `Invalid reference: entity "${targetId}" does not exist`,
          );
      // Undo log: on failure every target written so far gets its relations back.
      const written: { targetId: string; before: Relation[] }[] = [];
      try {
        for (const targetId of targets) {
          if (targetId === id) continue;
          const outgoing = next.filter(
            ({ target: t }) => t.kind === 'entity' && t.id === targetId,
          );
          const removedTypes = new Set(
            previous
              .filter(
                ({ target: t }) => t.kind === 'entity' && t.id === targetId,
              )
              .map(({ relationship }) => RELATION_INVERSES[relationship]),
          );
          // Read and write the target inside the store queue, so a concurrent
          // edit of its relations is merged, never overwritten.
          let before: Relation[] = [];
          await options.entities.mutateRelations(targetId, (relations) => {
            before = relations;
            const others = relations.filter(
              ({ target: t, relationship }) =>
                !(
                  t.kind === 'entity' &&
                  t.id === id &&
                  removedTypes.has(relationship)
                ),
            );
            return [
              ...others,
              ...outgoing.map(({ relationship }) => ({
                target: { kind: 'entity' as const, id },
                relationship: RELATION_INVERSES[relationship],
              })),
            ];
          });
          written.push({ targetId, before });
        }
      } catch (error) {
        for (const { targetId, before } of written.reverse())
          await options.entities
            .mutateRelations(targetId, () => before)
            .catch(() => undefined);
        throw error;
      }
    };
    this.tools = {
      listEntities: {
        description:
          'Find entities. Search before create; Names are unique within each type; disambiguate different identities.',
        inputSchema: z
          .object({
            query: z
              .string()
              .max(200)
              .default('')
              .describe(
                'Literal terms, case-insensitive, any term matches. Empty lists all. Searches title, type, facts and relationship types.',
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
                a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }) ||
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
          return entityReadResult(entity, names);
        }),
      },
      createEntity: {
        description:
          'Create new identity when no match exists. Facts only, no instructions. Need General and sources.',
        inputSchema: z
          .object({
            fields: writerFieldsSchema,
            sections: z.array(sectionSchema).min(1).max(5),
          })
          .strict(),
        execute: guarded(async ({ fields: raw, sections: input }) => {
          const fields = {
            ...raw,
            relatedTo: canonical(options.entities, raw.relatedTo),
          };
          const texts = (input as z.infer<typeof sectionSchema>[]).flatMap(
            (section) => section.facts.map(({ text }) => text),
          );
          rejectSecrets([fields, input], texts);
          checkEntity(
            fields.title,
            fields.tags,
            fields.relatedTo,
            texts,
            copiedValues(fields),
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
          try {
            await syncInverses(entity.id, fields.relatedTo, []);
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            const cleared = await options.entities
              .mutateRelations(entity.id, () => [])
              .then(
                () => true,
                () => false,
              );
            throw new Error(
              cleared
                ? `Entity ${entity.id} was created without relations because linking failed (${reason}). Add the relations with updateEntity`
                : `Entity ${entity.id} was created but linking failed (${reason}); some relations may be one-sided. Read it and fix RelatedTo with updateEntity`,
            );
          }
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
            fields: writerPatchSchema,
            revision: z
              .string()
              .regex(/^[a-f0-9]{16}$/)
              .describe('Revision from latest read. Conflict: read again.'),
            operations: z
              .array(curation ? curationOperationSchema : operationSchema)
              .max(50)
              .default([]),
          })
          .strict(),
        execute: guarded(async (input) => {
          const { revision, operations } = input;
          const fields = {
            ...input.fields,
            relatedTo:
              input.fields.relatedTo &&
              canonical(options.entities, input.fields.relatedTo),
          };
          rejectSecrets(
            [fields, operations],
            (operations as { text: string }[]).map(({ text }) => text),
          );
          const entity = options.entities.get(input.id);
          if (!entity) throw new Error('Unknown entity');
          const id = entity.id;
          if (entityRevision(entity) !== revision)
            throw new Error('Entity changed; read it again before editing');
          checkExisting(fields.linkedIdentities, fields.loadOn);
          const nextRelations: WriterRelation[] =
            fields.relatedTo ?? entity.frontmatter.RelatedTo;
          checkEntity(
            fields.title ?? entity.id,
            fields.tags ?? entity.frontmatter.Tags,
            nextRelations,
            (operations as Operation[])
              .filter(({ op }) =>
                ['add', 'supersede', 'reword', 'merge'].includes(op),
              )
              .map(({ text }) => text),
            copiedValues({
              linkedIdentities: fields.linkedIdentities,
              loadOn: fields.loadOn,
            }),
          );
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
                  sources: curation
                    ? inherited(operation.fromFacts ?? [])
                    : await evidence(sourceIds),
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
                const added = curation
                  ? fact.sources
                  : await evidence(sourceIds);
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
                const added = curation ? [] : await evidence(sourceIds);
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
            {
              ...fields,
              ...(fields.relatedTo ? { relatedTo: fields.relatedTo } : {}),
            },
            draft,
            Object.keys(entity.sections).filter(
              (name) => !Object.hasOwn(draft, name),
            ),
            revision,
          );
          if (fields.relatedTo) {
            try {
              await syncInverses(
                updated.id,
                fields.relatedTo,
                entity.frontmatter.RelatedTo,
              );
            } catch (error) {
              // Keep both sides consistent: restore the relations we replaced.
              const reason =
                error instanceof Error ? error.message : String(error);
              const restored = await options.entities
                .mutateRelations(updated.id, () => entity.frontmatter.RelatedTo)
                .then(
                  () => true,
                  () => false,
                );
              throw new Error(
                restored
                  ? `Relations were not changed because linking the other side failed (${reason}); other updates in this call were saved`
                  : `Linking the other side failed (${reason}) and relations could not be restored; some may be one-sided. Read the entity and fix RelatedTo`,
              );
            }
          }
          return {
            status: 'updated',
            id: updated.id,
            revision: entityRevision(updated),
            changedSections: [...changed].filter((name) =>
              Object.hasOwn(draft, name),
            ),
          };
        }),
      },
      mergeEntities: {
        description:
          'Fold a duplicate into the entity to keep. Only when clearly the same identity. Read both first. Facts, identities and references move over; dropped name is removed without an alias. Not undoable.',
        inputSchema: z
          .object({
            keepId: entityIdSchema,
            keepRevision: z.string().regex(/^[a-f0-9]{16}$/),
            dropId: entityIdSchema,
            dropRevision: z.string().regex(/^[a-f0-9]{16}$/),
          })
          .strict(),
        execute: guarded(
          async ({ keepId, keepRevision, dropId, dropRevision }) => {
            const keep = options.entities.get(keepId);
            const drop = options.entities.get(dropId);
            if (!keep || !drop) throw new Error('Unknown entity');
            if (keep.id === drop.id)
              throw new Error('Both IDs are the same entity');
            const self = options.selfName?.trim().toLowerCase();
            if (
              self &&
              [keep, drop].some(
                (entity) => entity.id.trim().toLowerCase() === self,
              )
            )
              throw new Error('Never merge into or from self');
            const merged = mergedEntity(keep, drop);
            checkShape(merged.sections, Object.keys(merged.sections), [], []);
            const { RelatedTo, LinkedIdentities, Tags } = merged.frontmatter;
            if (
              RelatedTo.length > 100 ||
              LinkedIdentities.length > 30 ||
              Tags.length > 20
            )
              throw new Error(
                `Merged entity would exceed limits (relations ${RelatedTo.length}/100, linked identities ${LinkedIdentities.length}/30, tags ${Tags.length}/20). Remove weak relations, stale identities or redundant tags with updateEntity first`,
              );
            if (options.signal.aborted) throw new Error('Writer closed');
            const result = await options.entities.merge(
              keepId,
              dropId,
              keepRevision,
              dropRevision,
            );
            return {
              status: 'merged',
              id: result.id,
              revision: entityRevision(result),
              sections: Object.keys(result.sections),
            };
          },
        ),
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
          if (reference === undefined) return skillReadResult(skill);
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
            const previous = Array.isArray(skill.metadata.sourceEpisodes)
              ? skill.metadata.sourceEpisodes.filter(
                  (id): id is string => typeof id === 'string',
                )
              : [];
            const recorded = await options.skills.setMetadata(input.name, {
              ...skill.metadata,
              sourceEpisodes: [
                ...new Set([...previous, ...input.sourceIds]),
              ].slice(-20),
            });
            const current = recorded ?? skill;
            return {
              status: 'written',
              id: current.id,
              references: current.references,
              revision: skillRevision(current),
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
          'Create learning skill from structured parts; tool renders it. Only when no existing skill fits.',
        inputSchema: skillCreateSchema,
        execute: skillWrite(
          async (input: z.infer<typeof skillCreateSchema>) => {
            const skill = structured(input);
            rejectSecrets(input, [input.when, ...skillTexts(skill)]);
            checkSkillWhen(input.when);
            checkSkill(skill);
            checkShape(Object.create(null), [], input.loadOn);
            if (!curation && options.evidenceText !== undefined)
              checkCopied(
                copiedValues({ loadOn: input.loadOn }).matchers,
                options.evidenceText,
                'LoadOn value',
              );
            await sources(input.sourceIds);
            if (options.skills.get(input.name))
              throw new Error('Skill already exists; read and update it');
            const similar = similarSkills(
              input.name,
              input.loadOn,
              options.skills
                .list()
                .filter((other) => !input.notDuplicateOf.includes(other.id)),
            );
            if (similar.length)
              throw new Error(
                `Similar: ${similar.join(', ')}. Read and extend it, or set notDuplicateOf: [ids] if it is a different procedure`,
              );
            const created = await options.skills.put(
              input.name,
              { description: input.when, body: renderSkillBody(skill) },
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
          },
        ),
      },
      updateLearnedSkill: {
        description:
          'Improve learning skill. Read first. Given lists replace whole lists; omitted keep. Free-form legacy skill: give steps to rewrite it.',
        inputSchema: curation
          ? skillUpdateSchema.omit({ sourceIds: true })
          : skillUpdateSchema,
        execute: skillWrite(
          async (
            input: Omit<z.infer<typeof skillUpdateSchema>, 'sourceIds'> & {
              sourceIds?: string[];
            },
          ) => {
            const sourceIds = input.sourceIds ?? [];
            const existing = options.skills.get(input.name);
            if (!existing) throw new Error('Unknown learned skill');
            if (skillRevision(existing) !== input.revision)
              throw new Error('Skill changed; read it again before editing');
            const current = parseSkillBody(existing.body);
            if (!current && !input.steps)
              throw new Error(
                'Free-form skill: give steps (and pitfalls, verify) to rewrite it in structured form',
              );
            const skill: StructuredSkill = {
              steps: input.steps ?? current?.steps ?? [],
              pitfalls: input.pitfalls ?? current?.pitfalls ?? [],
              verify: input.verify ?? current?.verify ?? '',
            };
            rejectSecrets(input, [input.when ?? '', ...skillTexts(skill)]);
            if (input.when !== undefined) checkSkillWhen(input.when);
            checkSkill(skill);
            checkShape(Object.create(null), [], input.loadOn);
            if (!curation && options.evidenceText !== undefined)
              checkCopied(
                copiedValues({ loadOn: input.loadOn }).matchers,
                options.evidenceText,
                'LoadOn value',
              );
            checkExisting([], input.loadOn);
            if (!curation) await evidence(sourceIds);
            if (options.signal.aborted) throw new Error('Writer closed');
            const updated = await options.skills.put(
              input.name,
              {
                description: input.when ?? existing.description,
                body: renderSkillBody(skill),
              },
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
                      ...sourceIds,
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
    if (curation)
      this.tools = Object.fromEntries(
        CURATION_TOOLS.map((name) => [name, this.tools[name]]),
      ) as ToolSet;
    for (const tool of Object.values(this.tools)) {
      const local = asSchema(tool.inputSchema);
      tool.inputSchema = jsonSchema(
        async () => providerSchema(await local.jsonSchema),
        { validate: local.validate },
      );
    }
  }
}
export function createWriterTools(options: WriterToolsOptions): WriterTools {
  return new WriterToolsModule(options);
}

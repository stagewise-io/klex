import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { parseSkillId } from '@/skills';

import {
  capSources,
  type Fact,
  type FactVersion,
  formatFacts,
  MAX_FACT_HISTORY,
  parseFacts,
} from './facts';

const wordIdSchema = z
  .string()
  .min(6)
  .max(24)
  .regex(/^(?:[a-z]+|(?:[A-Z][a-z]+){3})$/);
const text = z.string().trim().min(1).max(200);
const legacyEntityIdSchema = z
  .union([z.uuid(), wordIdSchema])
  .describe(
    'Immutable entity ID: three concatenated capitalized dictionary words, a legacy lowercase word ID, or a legacy UUID.',
  );
const entityTypeSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

// Tags are the ontology: lowercase kebab-case segments nested with `/`.
const TAG_CHARACTER = '[\\p{Ll}\\p{Lo}\\p{Lm}\\p{M}\\p{N}]';
const TAG_SEGMENT = `${TAG_CHARACTER}+(?:-${TAG_CHARACTER}+)*`;
const MAX_TAG_DEPTH = 4;
export const tagSchema = z
  .string()
  .max(100)
  .regex(
    new RegExp(
      `^${TAG_SEGMENT}(?:/${TAG_SEGMENT}){0,${MAX_TAG_DEPTH - 1}}$`,
      'u',
    ),
    'Expected lowercase kebab-case segments joined by /, e.g. people/coworkers',
  )
  .describe(
    'Ontology tag: lowercase kebab-case, nested with /, e.g. people/coworkers.',
  );
/** Converted folder path → tag: NFC, lowercase, other characters become `-`. */
export function normalizeTag(path: string): string {
  const segments = path
    .normalize('NFC')
    .toLowerCase()
    .split('/')
    .map((segment) =>
      segment
        .replace(/[^\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .slice(0, MAX_TAG_DEPTH);
  const kept: string[] = [];
  for (const segment of segments) {
    if ([...kept, segment].join('/').length > 100) break;
    kept.push(segment);
  }
  if (!kept.length && segments[0])
    kept.push(segments[0].slice(0, 100).replace(/-+$/, ''));
  return kept.join('/') || 'untagged';
}
const uniqueTags = (tags: readonly string[]): string[] => [...new Set(tags)];
const keyPathSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/)
  .describe(
    'Dot path to one key in event data or tool arguments, e.g. user, channel, payload.issue.identifier. No metadata. prefix.',
  );
const valueSchema = z
  .string()
  .min(1)
  .max(500)
  .describe('String value; event data is compared as text, so quote numbers.');
const serverSchema = text.describe(
  'MCP server/source name exactly as shown in context or action, e.g. slack, linear, github.',
);
const conditionSchema = z
  .object({
    path: keyPathSchema,
    match: z
      .enum(['exact', 'glob', 'regex'])
      .describe(
        'exact: whole value equal. glob: * any run, ? one char. regex: JavaScript pattern.',
      ),
    value: valueSchema,
  })
  .strict()
  .superRefine((condition, context) => {
    if (condition.match === 'regex')
      try {
        new RegExp(condition.value);
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid regex' });
      }
  });

/** Stable external identity; every key must equal its value. Also loads the entity. */
export const linkedIdentitySchema = z
  .object({
    server: serverSchema,
    match: z
      .record(keyPathSchema, valueSchema)
      .refine(
        (match) =>
          Object.keys(match).length >= 1 && Object.keys(match).length <= 10,
        '1-10 keys',
      )
      .describe(
        'Exact event-data keys identifying this entity on that server, ANDed, e.g. { user: "U071HL78SDN" } or { channel: "C1", thread_ts: "1792.1" }.',
      ),
  })
  .strict();
type LinkedIdentity = z.infer<typeof linkedIdentitySchema>;
export function identityKey(identity: LinkedIdentity): string {
  return JSON.stringify([
    identity.server,
    Object.entries(identity.match).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
export function formatIdentity(identity: LinkedIdentity): string {
  return `${identity.server} ${Object.entries(identity.match)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')}`;
}

/** Conditions within one matcher are ANDed; separate LoadOn entries are ORed. */
export const loadMatcherSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('contentPattern'),
      pattern: z
        .string()
        .trim()
        .min(2)
        .max(500)
        .describe(
          'Literal token seen verbatim in activity: key, ID, handle, full name, repo, symbol. 1-3 words. Never description or sentence.',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('pushNotificationMetadataPattern'),
      server: serverSchema,
      conditions: z
        .array(conditionSchema)
        .min(1)
        .max(30)
        .describe('ANDed conditions on stable event data keys.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('toolCallPattern'),
      mcpServer: serverSchema,
      toolName: text.optional(),
      arguments: z
        .array(conditionSchema)
        .max(30)
        .default([])
        .describe('ANDed identifying argument conditions.'),
    })
    .strict(),
]);
type LoadMatcher = z.infer<typeof loadMatcherSchema>;
// Stored matchers that no longer validate (e.g. unscoped) are dropped, not fatal.
const storedLoadOnSchema = z
  .array(z.unknown())
  .max(100)
  .default([])
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = loadMatcherSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );
const legacyRelationSchema = z
  .object({
    target: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('entity'), id: legacyEntityIdSchema })
        .strict(),
      z
        .object({
          kind: z.literal('skill'),
          id: z
            .string()
            .refine(
              (id) => parseSkillId(id) !== null,
              'Expected namespace/name',
            ),
        })
        .strict(),
    ]),
    strength: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe('Closeness. Raise as interaction repeats.'),
    relationship: text.describe(
      'Nature from this side, short: "manages", "teammate of", "reviews PRs of". Unknown: "talks with".',
    ),
  })
  .strict();

// Keep spelling and casing; only enforce portable, link-safe file names.
function normalizeNameSegment(value: string): string {
  let name = value
    .normalize('NFC')
    .replace(/[\\:*?"<>|#[\]^\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 100);
  while (Buffer.byteLength(name) > 200) name = name.slice(0, -1);
  name = name.replace(/[\s.]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = `_${name}`;
  return name;
}
export function normalizeEntityName(value: string): string {
  const parts = value.split('/');
  if (parts.some((part) => !part.trim() || /^\.{1,2}$/.test(part.trim())))
    throw new Error(
      'Memory names require nonempty relative path segments; no . or ..',
    );
  const normalized = parts.map(normalizeNameSegment);
  if (normalized.some((part) => !part || part.toLowerCase().endsWith('.md')))
    throw new Error('Memory path segments must be nonempty and omit .md');
  const name = normalized.join('/');
  if (name.length > 200 || Buffer.byteLength(name) > 400)
    throw new Error('Memory name exceeds path limit');
  return name;
}
const entityKey = (id: string) => id.normalize('NFC').toLowerCase();
/** Format 4–6 identity (`type/Name`, `type/namespace/Name`); forward-conversion reader only. */
const typedEntityIdSchema = z
  .string()
  .max(301)
  .refine((id) => {
    const [type, ...parts] = id.split('/');
    const name = parts.join('/');
    return (
      entityTypeSchema.safeParse(type).success &&
      name.length >= 2 &&
      name.length <= 200 &&
      Buffer.byteLength(name) <= 400 &&
      parts.length > 0 &&
      parts.every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          normalizeNameSegment(part) === part &&
          !part.toLowerCase().endsWith('.md'),
      )
    );
  }, 'Expected type/Name or type/namespace/Name, without .md');
/** Format 7 identity: the flat title, which is also the filename. */
export const entityIdSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (id) =>
      !id.includes('/') &&
      normalizeNameSegment(id) === id &&
      Buffer.byteLength(id) <= 200 &&
      !id.toLowerCase().endsWith('.md'),
    'Expected a memory title: one file name, no / and no .md',
  )
  .describe(
    'Memory title, unique across memory, e.g. Ada Lovelace or Mercury (company). No .md extension.',
  );
/** Writer title → filename: one portable segment; `/` becomes a space. */
export function normalizeTitle(value: string): string {
  const title = normalizeNameSegment(value.replace(/\//g, ' '));
  if (title.length < 2 || !entityIdSchema.safeParse(title).success)
    throw new Error(
      `Title "${value}" is not a usable file name; use at least two characters and no .md`,
    );
  return title;
}
// Released v4 relation contract: named targets, free-text relationship.
const v4RelationSchema = legacyRelationSchema.extend({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('entity'), id: typedEntityIdSchema }).strict(),
    legacyRelationSchema.shape.target.options[1],
  ]),
});
const v5RelationSchema = v4RelationSchema.extend({
  relationship: text
    .regex(/^[^[\]|\r\n]+$/, 'No [, ], | or line breaks')
    .describe(
      'Nature from this side, short: "manages", "teammate of", "reviews PRs of". Unknown: "talks with".',
    ),
});

/** Curated predicates, paired with their fixed inverse. Symmetric pairs repeat. */
export const RELATION_INVERSES = {
  worksFor: 'employs',
  employs: 'worksFor',
  memberOf: 'hasMember',
  hasMember: 'memberOf',
  reportsTo: 'supervises',
  supervises: 'reportsTo',
  collaboratesWith: 'collaboratesWith',
  represents: 'representedBy',
  representedBy: 'represents',
  providesTo: 'receivesFrom',
  receivesFrom: 'providesTo',
  ownedBy: 'owns',
  owns: 'ownedBy',
  managedBy: 'manages',
  manages: 'managedBy',
  assignedTo: 'assignedFrom',
  assignedFrom: 'assignedTo',
  createdBy: 'created',
  created: 'createdBy',
  approvedBy: 'approved',
  approved: 'approvedBy',
  requestedBy: 'requested',
  requested: 'requestedBy',
  partOf: 'hasPart',
  hasPart: 'partOf',
  dependsOn: 'requiredBy',
  requiredBy: 'dependsOn',
  uses: 'usedBy',
  usedBy: 'uses',
  integratesWith: 'integratesWith',
  hostedOn: 'hosts',
  hosts: 'hostedOn',
  locatedIn: 'hasLocatedEntity',
  hasLocatedEntity: 'locatedIn',
  contributesTo: 'receivesContributionFrom',
  receivesContributionFrom: 'contributesTo',
  blocks: 'blockedBy',
  blockedBy: 'blocks',
  implements: 'implementedBy',
  implementedBy: 'implements',
  addresses: 'addressedBy',
  addressedBy: 'addresses',
  affects: 'affectedBy',
  affectedBy: 'affects',
  follows: 'precedes',
  precedes: 'follows',
  derivedFrom: 'sourceOf',
  sourceOf: 'derivedFrom',
  references: 'referencedBy',
  referencedBy: 'references',
  describes: 'describedBy',
  describedBy: 'describes',
  supersedes: 'supersededBy',
  supersededBy: 'supersedes',
  conflictsWith: 'conflictsWith',
  relatedTo: 'relatedTo',
} as const;
export const relationshipTypeSchema = z
  .enum(
    Object.keys(RELATION_INVERSES) as [
      keyof typeof RELATION_INVERSES,
      ...(keyof typeof RELATION_INVERSES)[],
    ],
  )
  .describe(
    'Exact curated verb phrase from this entity to the target. Prefer a specific predicate; relatedTo is the fallback. Entity inverse is automatic.',
  );
// Format-6 relation contract: typed `type/Name` targets.
const v6RelationSchema = v5RelationSchema
  .omit({ strength: true })
  .extend({ relationship: relationshipTypeSchema });
// Format 7: entity targets are flat titles.
export const relationSchema = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('entity'), id: entityIdSchema }).strict(),
      legacyRelationSchema.shape.target.options[1],
    ]),
    relationship: relationshipTypeSchema,
  })
  .strict();

// Skill links name the skill file. Entity IDs never end in `.md`, so the
// suffix distinguishes them from entities such as `project/SKILL`.
const SKILL_LINK_SUFFIX = '/SKILL.md';
const V5_RELATION_LINK =
  /^\[\[([^[\]|\r\n]+)\|([^[\]|\r\n]+) \((\d{1,3})\)\]\]$/;
const RELATION_LINK = /^\[\[([^[\]|\r\n]+)\]\]$/;

/** Plain Obsidian target; the predicate lives in its frontmatter property. */
export function formatRelationLink(relation: Relation): string {
  const { target } = relation;
  const path =
    target.kind === 'skill' ? `${target.id}${SKILL_LINK_SUFFIX}` : target.id;
  return `[[${path}]]`;
}

function linkTarget(link: string): { kind: 'entity' | 'skill'; id: string } {
  const match = RELATION_LINK.exec(link);
  if (!match) throw new Error(`Malformed relation link: ${link}`);
  const [, path = ''] = match;
  return path.endsWith(SKILL_LINK_SUFFIX)
    ? { kind: 'skill', id: path.slice(0, -SKILL_LINK_SUFFIX.length) }
    : { kind: 'entity', id: path };
}

export function parseRelationLink(
  link: string,
  relationship: Relation['relationship'],
): Relation {
  return relationSchema.parse({ target: linkTarget(link), relationship });
}

// Format-6 reader: same plain links, typed targets.
function parseV6RelationLink(
  link: string,
  relationship: Relation['relationship'],
): Relation {
  return v6RelationSchema.parse({ target: linkTarget(link), relationship });
}

// Validate the released v5 link before the shared conversion drops its label and strength.
function parseV5RelationLink(link: string): z.infer<typeof v5RelationSchema> {
  const match = V5_RELATION_LINK.exec(link);
  if (!match) throw new Error(`Malformed relation link: ${link}`);
  const [, path = '', relationship = '', strength = ''] = match;
  return v5RelationSchema.parse({
    target: path.endsWith(SKILL_LINK_SUFFIX)
      ? { kind: 'skill', id: path.slice(0, -SKILL_LINK_SUFFIX.length) }
      : { kind: 'entity', id: path },
    relationship,
    strength: Number(strength),
  });
}

// Never guess predicates from historical free text. Preserve every target.
const fallbackRelations = (
  relations: readonly { target: Relation['target'] }[],
): Relation[] =>
  combineRelations(
    relations.map(({ target }) => ({ target, relationship: 'relatedTo' })),
  );

export const entityFieldsSchema = z
  .object({
    title: text
      .min(2)
      .max(100)
      .describe(
        'Name as people write it; becomes the filename. Unique across all memory, ignoring case. Clash with a different thing: add a singular qualifier in parentheses, e.g. "Mercury (company)", "Ada Lovelace (Acme)". No slashes; unsafe filename/link characters become spaces. Not a description.',
      ),
    tags: z
      .array(tagSchema)
      .min(1)
      .max(20)
      .describe(
        'Ontology: what it is. At least one, even when the title has a qualifier, e.g. Julian → ["people"]. Reuse known tags; nest with /, e.g. people/coworkers. New tags: plural, lowercase kebab-case. Replaces the whole list.',
      ),
    loadOn: z
      .array(loadMatcherSchema)
      .max(50)
      .default([])
      .describe(
        'Dedicated auto-load triggers; any one fires. Name and LinkedIdentities already trigger; never repeat them.',
      ),
    relatedTo: z.array(relationSchema).max(100).default([]),
    linkedIdentities: z
      .array(linkedIdentitySchema)
      .max(30)
      .default([])
      .describe(
        'Exact external IDs of this entity, unique across memory. Never repeat them in facts.',
      ),
  })
  .strict();

/** Patch omission must preserve collections, not apply create-time defaults. */
export const entityPatchSchema = entityFieldsSchema.partial().extend({
  loadOn: entityFieldsSchema.shape.loadOn.removeDefault().optional(),
  relatedTo: entityFieldsSchema.shape.relatedTo.removeDefault().optional(),
  linkedIdentities: entityFieldsSchema.shape.linkedIdentities
    .removeDefault()
    .optional(),
});

// The filename is the identity; v3 frontmatter never repeats it. Unknown
// properties (including a stale Id) are ignored on read and dropped on write.
const v3FrontmatterSchema = z.object({
  FormatVersion: z.literal(3),
  Title: text.min(2),
  CreatedAt: z.iso.datetime(),
  LastUpdatedAt: z.iso.datetime(),
  LastReadAt: z.iso.datetime().nullable(),
  LinkedIdentities: z.array(linkedIdentitySchema).max(30).default([]),
  LoadOn: storedLoadOnSchema,
  RelatedTo: z.array(legacyRelationSchema).max(100),
  TrustScore: z.literal(2),
  AuthorityScore: z.literal(5),
  /** IDs of entities merged into this one; they resolve here. Omitted when empty. */
  MergedFrom: z.array(legacyEntityIdSchema).min(1).max(100).optional(),
});

// Preserve existing UUID documents without rewriting their identities or references.
const uuidFrontmatterSchema = z.object({
  FormatVersion: z.literal(2),
  Id: z.uuid(),
  ...v3FrontmatterSchema.omit({ FormatVersion: true }).shape,
});
const oldFrontmatterSchema = z.union([
  v3FrontmatterSchema,
  uuidFrontmatterSchema,
]);
// Released v4: named files, object relations. Converted to v5 on startup.
const v4FrontmatterSchema = v3FrontmatterSchema
  .omit({ Title: true, MergedFrom: true, RelatedTo: true, FormatVersion: true })
  .extend({
    FormatVersion: z.literal(4),
    RelatedTo: z.array(v4RelationSchema).max(100),
  });
// v5 stores RelatedTo on disk as Obsidian links (see formatRelationLink).
const v5FrontmatterSchema = v4FrontmatterSchema
  .omit({ RelatedTo: true, FormatVersion: true })
  .extend({
    FormatVersion: z.literal(5),
    RelatedTo: z.array(v5RelationSchema).max(100),
  });
const v5LinkFrontmatterSchema = v5FrontmatterSchema.extend({
  RelatedTo: z.array(z.string()).max(100),
});
// Format 6 removes strength and groups plain links by curated predicates in one conversion.
// Runtime keeps a flat typed edge list; only the disk representation is grouped.
const v6FrontmatterSchema = v5FrontmatterSchema.extend({
  FormatVersion: z.literal(6),
  RelatedTo: z.array(v6RelationSchema).max(100),
});
const relationListsShape = Object.fromEntries(
  relationshipTypeSchema.options.map((type) => [
    type,
    z.array(z.string()).max(100).optional(),
  ]),
) as Record<Relation['relationship'], z.ZodOptional<z.ZodArray<z.ZodString>>>;
const v6LinkFrontmatterSchema = v6FrontmatterSchema
  .omit({ RelatedTo: true })
  .extend(relationListsShape)
  .strict();
// Format 7 flattens notes to `{Title}.md`; the ontology moves from the folder to Tags.
const frontmatterSchema = v6FrontmatterSchema
  .omit({ FormatVersion: true, RelatedTo: true })
  .extend({
    FormatVersion: z.literal(7),
    Tags: z.array(tagSchema).min(1).max(20),
    RelatedTo: z.array(relationSchema).max(100),
  });
const linkFrontmatterSchema = frontmatterSchema
  .omit({ RelatedTo: true })
  .extend(relationListsShape)
  .strict();

// Retain the original document contract for forward conversion of flat notes.
const legacyFrontmatterSchema = uuidFrontmatterSchema.extend({
  FormatVersion: z.literal(1),
  EntityType: text,
});

export type EntityFields = z.input<typeof entityFieldsSchema>;
export interface MemoryEntity {
  /** The title: derived from the filename, never stored in frontmatter. */
  id: string;
  frontmatter: z.infer<typeof frontmatterSchema>;
  sections: Record<string, Fact[]>;
}
export function entityRevision(entity: MemoryEntity): string {
  return createHash('sha256')
    .update(JSON.stringify(entity))
    .digest('hex')
    .slice(0, 16);
}

export const sectionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  // Hex escapes avoid ambiguous nested/escaped brackets in provider validators.
  .regex(/^[^\r\n#\x5b\x5d<>]+$/);

export interface EntityStore {
  start(): Promise<void>;
  list(): MemoryEntity[];
  get(id: string): MemoryEntity | null;
  create(
    fields: EntityFields,
    sections: Record<string, Fact[]>,
  ): Promise<MemoryEntity>;
  update(
    id: string,
    fields: Partial<EntityFields>,
    sections: Record<string, Fact[]>,
    removeSections?: string[],
    expectedRevision?: string,
  ): Promise<MemoryEntity>;
  /**
   * Read-modify-write of one entity's relations inside the store queue, so
   * concurrent edits cannot be overwritten by a stale copy.
   */
  mutateRelations(
    id: string,
    mutate: (relations: Relation[]) => Relation[],
  ): Promise<MemoryEntity>;
  /**
   * Folds `dropId` into `keepId` (see `mergedEntity`), repoints every
   * relation targeting `dropId` (fact text is untouched), then deletes its file.
   * A temporary journal completes interrupted changes; no aliases are retained.
   */
  merge(
    keepId: string,
    dropId: string,
    keepRevision: string,
    dropRevision: string,
  ): Promise<MemoryEntity>;
  /** Environment-only API. Never exposed to the writer's tools. */
  recordRead(id: string): Promise<void>;
  /** What startup converted to flat titles; null when nothing was converted. */
  conversion(): FlatConversionSummary | null;
}
export type Relation = z.infer<typeof relationSchema>;
const relationsSchema = z.array(relationSchema).max(100);

/** Main-session view: current facts only, no citations or superseded versions. */
export function renderEntity(
  entity: MemoryEntity,
  requestedSections: readonly string[] = [],
): string {
  const identities = entity.frontmatter.LinkedIdentities;
  return [
    `# ${entity.id}`,
    ...(identities.length
      ? [`IDs: ${identities.map(formatIdentity).join('; ')}`]
      : []),
    ...Object.entries(entity.sections)
      .filter(
        ([name]) => name === 'General' || requestedSections.includes(name),
      )
      .map(
        ([name, facts]) =>
          `## ${name}\n${facts.map((fact) => `- ${fact.text}`).join('\n')}`,
      ),
  ].join('\n\n');
}

// A matcher equal to the title or a linked identity adds nothing: both already load.
function dedupeLoadOn(
  matchers: readonly LoadMatcher[],
  title: string,
  identities: readonly LinkedIdentity[],
): LoadMatcher[] {
  const seen = new Set(identities.map(identityKey));
  return matchers.filter((matcher) => {
    if (
      matcher.type === 'contentPattern' &&
      matcher.pattern.toLowerCase() === title.toLowerCase()
    )
      return false;
    const key =
      matcher.type === 'pushNotificationMetadataPattern' &&
      matcher.conditions.every((condition) => condition.match === 'exact')
        ? identityKey({
            server: matcher.server,
            match: Object.fromEntries(
              matcher.conditions.map(({ path, value }) => [path, value]),
            ),
          })
        : JSON.stringify(matcher);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeIdentities(
  identities: readonly LinkedIdentity[],
): LinkedIdentity[] {
  const seen = new Set<string>();
  return identities.filter((identity) => {
    const key = identityKey(identity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One edge per predicate and target; never to `exclude`. */
function combineRelations(
  relations: readonly Relation[],
  exclude: readonly string[] = [],
): Relation[] {
  const byTarget = new Map<string, Relation>();
  for (const relation of relations) {
    const { kind, id } = relation.target;
    if (kind === 'entity' && exclude.includes(id)) continue;
    const key = `${relation.relationship}:${kind}:${entityKey(id)}`;
    if (!byTarget.has(key)) byTarget.set(key, relation);
  }
  return [...byTarget.values()];
}

/**
 * `keep` after absorbing `drop`: sections joined by name, equal facts
 * combined (sources and `was:` history kept within caps), identities,
 * matchers, tags and relations unioned. Relations between the two vanish; for
 * a shared target distinct predicates survive. Title and dates stay.
 */
export function mergedEntity(
  keep: MemoryEntity,
  drop: MemoryEntity,
): MemoryEntity {
  const sections: Record<string, Fact[]> = Object.assign(
    Object.create(null),
    structuredClone(keep.sections),
  );
  for (const [name, facts] of Object.entries(structuredClone(drop.sections))) {
    const target = sections[name] ?? [];
    sections[name] = target;
    for (const fact of facts) {
      const same = target.find((existing) => existing.text === fact.text);
      if (!same) {
        target.push(fact);
        continue;
      }
      same.sources = capSources([...same.sources, ...fact.sources]);
      same.history = [...same.history, ...fact.history].slice(
        0,
        MAX_FACT_HISTORY,
      );
    }
  }
  const { frontmatter } = keep;
  const identities = dedupeIdentities([
    ...frontmatter.LinkedIdentities,
    ...drop.frontmatter.LinkedIdentities,
  ]);
  return {
    ...keep,
    sections,
    frontmatter: {
      ...frontmatter,
      Tags: uniqueTags([...frontmatter.Tags, ...drop.frontmatter.Tags]),
      LinkedIdentities: identities,
      LoadOn: dedupeLoadOn(
        [...frontmatter.LoadOn, ...drop.frontmatter.LoadOn],
        keep.id,
        identities,
      ),
      RelatedTo: combineRelations(
        [...frontmatter.RelatedTo, ...drop.frontmatter.RelatedTo],
        [keep.id, drop.id],
      ),
    },
  };
}

function validateSections(sections: Record<string, Fact[]>): void {
  for (const [name, facts] of Object.entries(sections)) {
    sectionNameSchema.parse(name);
    if (!Array.isArray(facts) || !facts.length)
      throw new Error(`Section ${name} must contain at least one fact`);
  }
  if (Object.keys(sections).length > 50 || !Object.hasOwn(sections, 'General'))
    throw new Error('An entity requires General and at most 50 sections');
}

function serialize(entity: MemoryEntity): string {
  frontmatterSchema.parse(entity.frontmatter);
  entityIdSchema.parse(entity.id);
  validateSections(entity.sections);
  // FormatVersion first, so tools can sniff the version from the first line.
  const { FormatVersion, Tags, RelatedTo, ...rest } = entity.frontmatter;
  const relations = combineRelations(RelatedTo);
  const frontmatter = {
    FormatVersion,
    Tags,
    ...rest,
    ...Object.fromEntries(
      relationshipTypeSchema.options.flatMap((type) => {
        const links = relations
          .filter(({ relationship }) => relationship === type)
          .map(formatRelationLink);
        return links.length ? [[type, links]] : [];
      }),
    ),
  };
  // No folding: a link must stay on one line.
  const content = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${Object.entries(
    entity.sections,
  )
    .map(([name, facts]) => `## ${name}\n\n${formatFacts(facts)}`)
    .join('\n\n')}\n`;
  if (Buffer.byteLength(content) > 500_000)
    throw new Error('Entity exceeds size limit');
  return content;
}

const folderOf = (id: string): string | undefined =>
  id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : undefined;

/**
 * Notes before format 7 come back already flattened in memory: format 7
 * frontmatter with the folder path as the only tag, but still keyed by their
 * old typed ID (or legacy stem) and with old link targets. The startup
 * conversion assigns titles and rewrites targets before anything is written.
 */
function deserialize(
  content: string,
  id: string,
  folder: string | undefined = folderOf(id),
): {
  entity: MemoryEntity;
  legacy: boolean;
  outdated: boolean;
  old?: LegacyFields;
} {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (!match?.[1] || match[2] === undefined)
    throw new Error('Missing entity frontmatter');
  const raw = parse(match[1], { maxAliasCount: 0 });
  let old: LegacyFields | undefined;
  let v4: z.infer<typeof v4FrontmatterSchema> | undefined;
  let tagSource = '';
  if (raw?.FormatVersion === 1) {
    const legacy = legacyFrontmatterSchema.parse(raw);
    if (legacy.Id !== id.split('/').at(-1))
      throw new Error('Legacy ID does not match filename');
    tagSource = entityTypeSchema.parse(legacy.EntityType);
    if (folder !== undefined && folder !== tagSource)
      throw new Error('Legacy entity type does not match folder');
    const {
      EntityType: _type,
      Id: _id,
      FormatVersion: _version,
      ...fields
    } = legacy;
    old = fields;
  } else if (raw?.FormatVersion === 7) {
    if (folder !== undefined)
      throw new Error(
        'Format 7 notes must sit directly in the memory root, not in a folder',
      );
  } else {
    if (folder === undefined)
      throw new Error('Notes before format 7 must sit in a type folder');
    entityTypeSchema.parse(folder.split('/')[0]);
    tagSource = folder;
    if (raw?.FormatVersion === 4) v4 = v4FrontmatterSchema.parse(raw);
    else if (![5, 6].includes(raw?.FormatVersion)) {
      const legacy = oldFrontmatterSchema.parse(raw);
      if ('Id' in legacy && legacy.Id !== id.split('/').at(-1))
        throw new Error('Legacy ID does not match filename');
      const { FormatVersion: _version, ...fields } = legacy;
      old = fields;
    }
  }
  // The literal folder path becomes the only tag; a consolidator normalizes later.
  const Tags = [normalizeTag(tagSource)];
  let frontmatter: MemoryEntity['frontmatter'];
  if (old)
    frontmatter = {
      ...v6FrontmatterSchema
        .omit({ RelatedTo: true })
        .parse({ ...old, FormatVersion: 6 }),
      FormatVersion: 7,
      Tags,
      // Legacy targets are repointed to titles before the note is written.
      RelatedTo: fallbackRelations(old.RelatedTo),
    };
  else if (v4)
    frontmatter = {
      ...v4,
      FormatVersion: 7,
      Tags,
      RelatedTo: fallbackRelations(v4.RelatedTo),
    };
  else if (raw?.FormatVersion === 5) {
    const stored = v5LinkFrontmatterSchema.parse(raw);
    frontmatter = {
      ...stored,
      FormatVersion: 7,
      Tags,
      RelatedTo: fallbackRelations(stored.RelatedTo.map(parseV5RelationLink)),
    };
  } else if (raw?.FormatVersion === 6) {
    const stored = v6LinkFrontmatterSchema.parse(raw);
    const relations = relationshipTypeSchema.options.flatMap((type) =>
      (stored[type] ?? []).map((link) => parseV6RelationLink(link, type)),
    );
    frontmatter = {
      ...v6FrontmatterSchema.omit({ RelatedTo: true }).parse(stored),
      FormatVersion: 7,
      Tags,
      RelatedTo: combineRelations(relations),
    };
  } else {
    const stored = linkFrontmatterSchema.parse(raw);
    const relations = relationshipTypeSchema.options.flatMap((type) =>
      (stored[type] ?? []).map((link) => parseRelationLink(link, type)),
    );
    frontmatter = frontmatterSchema.parse({
      ...stored,
      RelatedTo: combineRelations(relations),
    });
  }
  const sections: Record<string, Fact[]> = Object.create(null);
  for (const section of match[2].split(/^## /m).slice(1)) {
    const line = section.indexOf('\n');
    const name = (line < 0 ? section : section.slice(0, line)).trim();
    if (Object.hasOwn(sections, name)) throw new Error('Duplicate section');
    const facts = parseFacts(line < 0 ? '' : section.slice(line + 1));
    if (facts.length) sections[name] = facts;
  }
  validateSections(sections);
  return {
    entity: { id, frontmatter, sections },
    legacy: !!old,
    outdated: raw?.FormatVersion !== 7,
    old,
  };
}

export interface FlatConversionSummary {
  /** Notes moved from type folders to the memory root. */
  moved: number;
  /** Converted notes whose title differs from their old file name. */
  renamed: { from: string; to: string }[];
  /** Case-insensitive title clashes, resolved with qualifiers. */
  collisions: string[][];
  /** Entity links whose target note does not exist; dropped. */
  droppedLinks: { entity: string; target: string }[];
  /** Missing inverse links written on the target note. */
  addedInverses: number;
  /** Planned only; nothing was written. */
  dryRun: boolean;
}

export interface EntityStoreOptions {
  /** Plan the startup conversion and report it via `conversion()`; never write. */
  dryRun?: boolean;
  /**
   * Only the application startup migration converts old notes. Every other
   * store (the memory writer) refuses to start on unconverted notes instead
   * of migrating them mid-session.
   */
  migrate?: boolean;
  /** Called with the conversion plan before anything is written. */
  onConversionPlanned?: (summary: FlatConversionSummary) => void;
  /**
   * Awaited after planning and before the first write of a real conversion,
   * e.g. to persist the compatibility marker older binaries check.
   */
  beforeConversionWrite?: () => Promise<void>;
}

const MAX_QUALIFIER = 60;
function qualifiedTitle(leaf: string, qualifier: string): string {
  const ending = ` (${qualifier.slice(0, MAX_QUALIFIER).trim()})`;
  let base = leaf;
  while (
    base &&
    (base.length + ending.length > 100 ||
      Buffer.byteLength(base + ending) > 200)
  )
    base = base.slice(0, -1);
  return normalizeNameSegment(`${base.trimEnd()}${ending}`);
}

/**
 * Pure title planner for the one-time flattening; no I/O. Non-clashing leaves
 * keep their name. Every member of a case-insensitive clash group (or a leaf
 * clashing with an existing flat title) gets a qualifier: the top-level folder,
 * else the full folder path, else the full path plus a number.
 */
export function planFlatTitles(
  sources: readonly { folder: string; leaf: string }[],
  reserved: readonly string[] = [],
): { titles: string[]; collisions: string[][] } {
  const taken = new Set(reserved.map(entityKey));
  const groups = new Map<string, number[]>();
  sources.forEach(({ leaf }, index) => {
    const key = entityKey(leaf);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const titles: string[] = sources.map(() => '');
  const clashing: number[][] = [];
  // Plain names first, so a qualified title never takes a plain one.
  for (const [key, members] of groups) {
    const [only] = members;
    const source = only === undefined ? undefined : sources[only];
    if (
      members.length === 1 &&
      only !== undefined &&
      source &&
      source.leaf.length >= 2 &&
      !taken.has(key)
    ) {
      titles[only] = source.leaf;
      taken.add(key);
    } else clashing.push(members);
  }
  const collisions: string[][] = [];
  const levels = [
    (folder: string) => folder.split('/')[0] ?? folder,
    (folder: string) => folder.split('/').join(' '),
  ];
  for (const members of clashing) {
    const group = members.flatMap((index) => {
      const source = sources[index];
      return source ? [{ index, ...source }] : [];
    });
    let chosen: string[] | undefined;
    for (const level of levels) {
      const candidates = group.map(({ leaf, folder }) =>
        qualifiedTitle(leaf, level(folder)),
      );
      const keys = candidates.map(entityKey);
      if (
        new Set(keys).size === keys.length &&
        keys.every((key) => !taken.has(key))
      ) {
        chosen = candidates;
        break;
      }
    }
    if (!chosen) {
      const used = new Set<string>();
      chosen = group.map(({ leaf, folder }) => {
        const path = folder.split('/').join(' ');
        let candidate = qualifiedTitle(leaf, path);
        for (
          let number = 2;
          taken.has(entityKey(candidate)) || used.has(entityKey(candidate));
          number++
        ) {
          if (number > 100_000)
            throw new Error(`Cannot plan a unique memory title for ${leaf}`);
          // Reserve room for the number so qualifier truncation never drops it.
          const suffix = ` ${number}`;
          candidate = qualifiedTitle(
            leaf,
            `${path.slice(0, MAX_QUALIFIER - suffix.length).trimEnd()}${suffix}`,
          );
        }
        used.add(entityKey(candidate));
        return candidate;
      });
    }
    group.forEach(({ index }, position) => {
      const title = chosen[position] ?? '';
      titles[index] = title;
      taken.add(entityKey(title));
    });
    collisions.push(chosen);
  }
  return { titles, collisions };
}

class EntityStoreModule implements EntityStore {
  private readonly entities = new Map<string, MemoryEntity>();
  private starting: Promise<void> | undefined;
  private work = Promise.resolve();
  private interrupted = false;
  private summary: FlatConversionSummary | null = null;

  constructor(
    private readonly directory: string,
    private readonly options: EntityStoreOptions = {},
  ) {}

  conversion(): FlatConversionSummary | null {
    return structuredClone(this.summary);
  }

  start(): Promise<void> {
    this.starting ??= this.load();
    return this.starting;
  }
  list(): MemoryEntity[] {
    return structuredClone([...this.entities.values()]);
  }
  get(id: string): MemoryEntity | null {
    entityIdSchema.parse(id);
    return structuredClone(this.entities.get(entityKey(id)) ?? null);
  }

  create(
    fields: EntityFields,
    sections: Record<string, Fact[]>,
  ): Promise<MemoryEntity> {
    const input = entityFieldsSchema.parse(fields);
    return this.enqueue(async () => {
      const at = new Date().toISOString();
      const identities = dedupeIdentities(input.linkedIdentities);
      this.checkIdentities(identities);
      const id = this.availableId(normalizeTitle(input.title));
      const entity: MemoryEntity = {
        id,
        frontmatter: {
          FormatVersion: 7,
          Tags: uniqueTags(input.tags),
          CreatedAt: at,
          LastUpdatedAt: at,
          LastReadAt: null,
          LinkedIdentities: identities,
          LoadOn: dedupeLoadOn(input.loadOn, id, identities),
          RelatedTo: combineRelations(input.relatedTo),
          TrustScore: 2,
          AuthorityScore: 5,
        },
        sections: structuredClone(sections),
      };
      await this.persist(entity);
      return structuredClone(entity);
    });
  }

  update(
    id: string,
    fields: Partial<EntityFields>,
    sections: Record<string, Fact[]>,
    removeSections: string[] = [],
    expectedRevision?: string,
  ): Promise<MemoryEntity> {
    entityIdSchema.parse(id);
    const patch = entityPatchSchema.parse(fields);
    return this.enqueue(async () => {
      const entity = this.get(id);
      if (!entity) throw new Error('Unknown entity');
      if (
        expectedRevision !== undefined &&
        entityRevision(entity) !== expectedRevision
      )
        throw new Error('Entity changed; read it again before editing');
      if (removeSections.includes('General'))
        throw new Error('General cannot be removed');
      for (const name of removeSections)
        delete entity.sections[sectionNameSchema.parse(name)];
      entity.sections = Object.fromEntries([
        ...Object.entries(entity.sections),
        ...Object.entries(sections),
      ]);
      const previousId = entity.id;
      entity.id = this.availableId(
        patch.title === undefined ? entity.id : normalizeTitle(patch.title),
        previousId,
      );
      const previous = entity.frontmatter;
      const identities = patch.linkedIdentities
        ? dedupeIdentities(patch.linkedIdentities)
        : previous.LinkedIdentities;
      this.checkIdentities(identities, previousId);
      entity.frontmatter = {
        ...previous,
        Tags: patch.tags ? uniqueTags(patch.tags) : previous.Tags,
        LinkedIdentities: identities,
        LoadOn: dedupeLoadOn(
          patch.loadOn ?? previous.LoadOn,
          entity.id,
          identities,
        ),
        RelatedTo: combineRelations(patch.relatedTo ?? previous.RelatedTo),
        LastUpdatedAt: new Date().toISOString(),
      };
      if (entity.id === previousId) await this.persist(entity);
      else
        await this.identityChange({
          moves: [
            { from: previousId, to: entity.id, path: `${previousId}.md` },
          ],
          documents: [{ id: entity.id, content: serialize(entity) }],
        });
      const saved = this.get(entity.id);
      if (!saved) throw new Error('Saved entity is missing');
      return saved;
    });
  }

  mutateRelations(
    id: string,
    mutate: (relations: Relation[]) => Relation[],
  ): Promise<MemoryEntity> {
    entityIdSchema.parse(id);
    return this.enqueue(async () => {
      const entity = this.get(id);
      if (!entity) throw new Error('Unknown entity');
      entity.frontmatter = {
        ...entity.frontmatter,
        RelatedTo: combineRelations(
          relationsSchema.parse(mutate(entity.frontmatter.RelatedTo)),
        ),
        LastUpdatedAt: new Date().toISOString(),
      };
      await this.persist(entity);
      return structuredClone(entity);
    });
  }

  merge(
    keepId: string,
    dropId: string,
    keepRevision: string,
    dropRevision: string,
  ): Promise<MemoryEntity> {
    return this.enqueue(async () => {
      const keep = this.get(keepId);
      const drop = this.get(dropId);
      if (!keep || !drop) throw new Error('Unknown entity');
      if (keep.id === drop.id)
        throw new Error('Cannot merge an entity into itself');
      if (
        entityRevision(keep) !== keepRevision ||
        entityRevision(drop) !== dropRevision
      )
        throw new Error('Entity changed; read both again before merging');
      const merged = mergedEntity(keep, drop);
      merged.frontmatter.LastUpdatedAt = new Date().toISOString();
      await this.identityChange({
        moves: [{ from: drop.id, to: keep.id, path: `${drop.id}.md` }],
        documents: [{ id: keep.id, content: serialize(merged) }],
      });
      const saved = this.get(keep.id);
      if (!saved) throw new Error('Merged entity is missing');
      return saved;
    });
  }

  async recordRead(id: string): Promise<void> {
    await this.enqueue(async () => {
      const entity = this.get(id);
      if (!entity) throw new Error('Unknown entity');
      entity.frontmatter.LastReadAt = new Date().toISOString();
      await this.persist(entity);
    });
  }

  /** One external identity belongs to exactly one entity. */
  private checkIdentities(
    identities: readonly LinkedIdentity[],
    self?: string,
  ): void {
    const owners = new Map<string, MemoryEntity>();
    for (const entity of this.entities.values())
      if (entity.id !== self)
        for (const identity of entity.frontmatter.LinkedIdentities)
          owners.set(identityKey(identity), entity);
    for (const identity of identities) {
      const owner = owners.get(identityKey(identity));
      if (owner)
        throw new Error(
          `Linked identity "${formatIdentity(identity)}" already belongs to entity "${owner.id}"; update that entity instead`,
        );
    }
  }

  /** Titles are unique across the whole memory root, ignoring case and NFC. */
  private availableId(title: string, self?: string): string {
    entityIdSchema.parse(title);
    const other = this.entities.get(entityKey(title));
    if (other && other.id !== self)
      throw new Error(
        `Title "${title}" is already used by "${other.id}" (tags: ${other.frontmatter.Tags.join(', ')}). Same thing: update "${other.id}" instead. Different thing: pick a title with a singular qualifier in parentheses, e.g. "${title} (company)".`,
      );
    return title;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.work;
    const result = this.start().then(() =>
      previous.then(() => {
        if (this.options.dryRun)
          throw new Error('Dry-run memory store is read-only');
        if (this.interrupted)
          throw new Error('Memory change interrupted; restart to finish it');
        return action();
      }),
    );
    this.work = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory())
      throw new Error('Entity root must be a plain directory');
  }

  // Walk one component at a time; recursive mkdir/lstat of only the final
  // parent would follow an intermediate symlink outside the memory root.
  // Format-7 titles are flat (no folders), so this only does work for legacy
  // nested journal paths replayed before the startup conversion.
  private async checkParents(path: string, create = false): Promise<boolean> {
    let folder = this.directory;
    for (const part of path.split('/').slice(0, -1)) {
      const names = await readdir(folder);
      if (
        names.some(
          (name) =>
            entityKey(name) === entityKey(part) &&
            name.normalize('NFC') !== part.normalize('NFC'),
        )
      )
        throw new Error('Memory folder casing conflicts');
      folder = join(folder, part);
      if (create)
        await mkdir(folder, { mode: 0o700 }).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(folder);
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT')
          return false;
        throw error;
      }
      if (!info.isDirectory())
        throw new Error('Memory parent must be a plain directory');
    }
    return true;
  }

  private async persist(entity: MemoryEntity): Promise<void> {
    await this.writeDocument(
      `${entityIdSchema.parse(entity.id)}.md`,
      serialize(entity),
    );
    this.entities.set(entityKey(entity.id), structuredClone(entity));
  }

  private async writeDocument(path: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > 500_000)
      throw new Error('Entity exceeds size limit');
    await this.ensureDirectory();
    const file = join(this.directory, path);
    await this.checkParents(path, true);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      const handle = await open(temporary, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Journal final document contents, not just names: replay is idempotent even
   * when one new name equals another old name or a merge stops mid-write. */
  private async commit(journal: MovesJournal): Promise<void> {
    validateJournal(journal);
    const file = join(this.directory, '.moves.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(journal));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    try {
      await this.applyMoves(journal);
      await rm(file);
    } catch (error) {
      this.interrupted = true;
      throw new Error('Memory change interrupted; restart to finish it', {
        cause: error,
      });
    }
  }

  private async applyMoves(journal: MovesJournal): Promise<void> {
    validateJournal(journal);
    // Validate all ancestor chains before deleting any source.
    for (const move of journal.moves)
      if (move.path) await this.checkParents(move.path);
    for (const document of journal.documents)
      await this.checkParents(`${document.id}.md`, true);
    // Delete sources before writing final snapshots. A case-only rename must
    // remove the old directory entry on case-insensitive filesystems, too.
    for (const move of journal.moves) {
      if (!move.path) continue;
      const file = join(this.directory, move.path);
      const parent = dirname(file);
      if (!(await this.checkParents(move.path))) continue;
      if (
        (await readdir(parent)).some(
          (name) => name.normalize('NFC') === basename(file).normalize('NFC'),
        )
      )
        await rm(file);
    }
    for (const document of journal.documents) {
      // Journals from before format 7 hold nested notes: restore them verbatim;
      // the startup conversion then flattens them like any other old note.
      if (document.id.includes('/'))
        await this.writeDocument(`${document.id}.md`, document.content);
      else
        await this.persist(deserialize(document.content, document.id).entity);
    }
    // Remove only empty former parent folders, never recursively.
    for (const move of journal.moves) {
      if (!move.path) continue;
      let folder = dirname(join(this.directory, move.path));
      while (folder !== this.directory) {
        try {
          await rmdir(folder);
        } catch (error) {
          if (
            ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            break;
          throw error;
        }
        folder = dirname(folder);
      }
    }
    for (const { from } of journal.moves) {
      if (
        !journal.documents.some(({ id }) => entityKey(id) === entityKey(from))
      )
        this.entities.delete(entityKey(from));
    }
  }

  private async identityChange(journal: MovesJournal): Promise<void> {
    const replacements = new Map(
      journal.moves.map(({ from, to }) => [from, to]),
    );
    const next = new Map(this.entities);
    for (const { from } of journal.moves) next.delete(entityKey(from));
    for (const { id, content } of journal.documents)
      next.set(entityKey(id), deserialize(content, id).entity);
    const documents: MovesJournal['documents'] = [];
    for (const entity of next.values()) {
      // Relations only: prose mentions of a plain title may mean someone else.
      const rewritten = replaceReferences(entity, replacements);
      if (
        JSON.stringify(rewritten) !==
        JSON.stringify(this.entities.get(entityKey(entity.id)))
      )
        documents.push({ id: entity.id, content: serialize(rewritten) });
    }
    await this.commit({ moves: journal.moves, documents });
  }

  private async load(): Promise<void> {
    await this.ensureDirectory();
    let pending: MovesJournal | undefined;
    try {
      pending = movesJournalSchema.parse(
        JSON.parse(await readFile(join(this.directory, '.moves.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (pending) {
      if (this.options.dryRun)
        throw new Error(
          'An interrupted memory change is pending; start without dry run to finish it',
        );
      await this.applyMoves(pending);
      await rm(join(this.directory, '.moves.json'));
      this.entities.clear();
    }
    const documents: LoadedDocument[] = [];
    const ids = new Set<string>();
    const readDocument = async (
      file: string,
      name: string,
      folder?: string,
    ) => {
      const stem = name.slice(0, -3).normalize('NFC');
      const id = folder ? `${folder}/${stem}` : stem;
      const handle = await open(
        file,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 500_000)
          throw new Error('Invalid entity file');
        const content = await handle.readFile('utf8');
        const { entity, legacy, outdated, old } = deserialize(
          content,
          id,
          folder,
        );
        if (legacy) legacyEntityIdSchema.parse(stem);
        else if (folder) typedEntityIdSchema.parse(id);
        else entityIdSchema.parse(id);
        const key = legacy ? stem : entityKey(id);
        if (ids.has(key)) throw new Error('Duplicate entity identity');
        ids.add(key);
        documents.push({ file, entity, legacy, outdated, old, stem, folder });
      } catch (error) {
        throw new Error(`Invalid entity ${file}`, { cause: error });
      } finally {
        await handle.close();
      }
    };
    const folders = new Map<string, string>();
    const walk = async (directory: string, prefix = ''): Promise<void> => {
      for (const entry of await readdir(directory, {
        withFileTypes: true,
      })) {
        const file = join(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new Error('Memory parent must be a plain directory');
        if (entry.isDirectory()) {
          // Obsidian and other editors own hidden metadata directories, not entities.
          if (entry.name.startsWith('.')) continue;
          const path = prefix
            ? `${prefix}/${entry.name.normalize('NFC')}`
            : entry.name;
          if (!prefix) {
            if (!entityTypeSchema.safeParse(entry.name).success)
              throw new Error(
                `Invalid memory entity type folder "${file}"; expected lowercase kebab-case`,
              );
          } else {
            const name = path.slice(path.indexOf('/') + 1);
            if (
              !name ||
              normalizeEntityName(name) !== name ||
              name
                .split('/')
                .some((part) => !part || part.toLowerCase().endsWith('.md'))
            )
              throw new Error('Unsafe memory folder');
          }
          const previous = folders.get(entityKey(path));
          if (previous && previous !== path)
            throw new Error('Memory folder casing conflicts');
          folders.set(entityKey(path), path);
          await walk(file, path);
        } else if (entry.name.endsWith('.md')) {
          if (!entry.isFile()) throw new Error('Entity must be a regular file');
          await readDocument(file, entry.name, prefix || undefined);
        }
      }
    };
    await walk(this.directory);
    // A merge interrupted before deleting the dropped file left it next to
    // the kept entity, which already holds its content: finish the merge.
    const merged = new Set(
      documents.flatMap(({ old }) => old?.MergedFrom ?? []),
    );
    const active = documents.filter(({ stem }) => !merged.has(stem));
    // One external identity belongs to exactly one entity; files edited by hand
    // must not break that before any note is converted or served.
    const owners = new Map<string, string>();
    for (const { entity } of active)
      for (const identity of entity.frontmatter.LinkedIdentities) {
        const key = identityKey(identity);
        const owner = owners.get(key);
        if (owner && owner !== entity.id)
          throw new Error(
            `Linked identity "${formatIdentity(identity)}" belongs to both ${owner} and ${entity.id}; remove it from one`,
          );
        owners.set(key, entity.id);
      }
    // One-time flattening: every note before format 7 moves to `{Title}.md`.
    // Old typed IDs (and legacy stems) map to titles; clashes get qualifiers.
    const converting = active
      .filter(({ outdated }) => outdated)
      .sort((a, b) => a.file.localeCompare(b.file));
    if (
      (converting.length || merged.size) &&
      !this.options.migrate &&
      !this.options.dryRun
    )
      throw new Error(
        'Memory notes are not migrated yet; the startup migration must finish first',
      );
    const sources = converting.map(({ entity, old, folder }) => {
      if (!old)
        return {
          folder: folder ?? '',
          leaf: entity.id.slice(entity.id.lastIndexOf('/') + 1),
        };
      // Legacy titles may carry a namespace (org/repo); it joins the folder path.
      const parts = normalizeEntityName(old.Title).split('/');
      const leaf = parts.pop() ?? '';
      const path = [folder ?? entity.frontmatter.Tags[0] ?? '', ...parts].join(
        '/',
      );
      if (parts.length) entity.frontmatter.Tags = [normalizeTag(path)];
      return { folder: path, leaf: leaf.length >= 2 ? leaf : 'Untitled' };
    });
    const flat = active
      .filter(({ outdated }) => !outdated)
      .map(({ entity }) => entity.id);
    const { titles, collisions } = planFlatTitles(sources, flat);
    const replacements = new Map<string, string>();
    const moves: MovesJournal['moves'] = [];
    const renamed: FlatConversionSummary['renamed'] = [];
    converting.forEach((document, index) => {
      const title = titles[index];
      if (!title) throw new Error('Unplanned memory title');
      const from = document.legacy ? document.stem : document.entity.id;
      replacements.set(from, title);
      if (title !== document.stem) renamed.push({ from, to: title });
      moves.push({
        from,
        to: title,
        path: relative(this.directory, document.file).split(sep).join('/'),
      });
      document.entity.id = title;
    });
    for (const { entity, old } of active)
      for (const alias of old?.MergedFrom ?? [])
        if (!replacements.has(alias)) replacements.set(alias, entity.id);
    // Finish legacy merges without retaining the alias list.
    for (const document of documents.filter(({ stem }) => merged.has(stem))) {
      const to = replacements.get(document.stem);
      if (!to) throw new Error('Unresolved legacy merge');
      moves.push({
        from: document.stem,
        to,
        path: relative(this.directory, document.file).split(sep).join('/'),
      });
    }
    // Link targets resolve exactly, then ignoring case (hand-typed links).
    const byKey = new Map<string, string>(
      flat.map((id) => [entityKey(id), id]),
    );
    for (const [from, to] of replacements) byKey.set(entityKey(from), to);
    const resolve = (id: string) =>
      replacements.get(id) ?? byKey.get(entityKey(id));
    const droppedLinks: FlatConversionSummary['droppedLinks'] = [];
    // Current notes are repointed too, so their dangling links are dropped and
    // reported like everyone else's. Prose is rewritten only on old notes.
    const final = active.map(({ entity, outdated }) =>
      outdated || moves.length
        ? retargetRelations(
            outdated ? rewriteProse(entity, replacements) : entity,
            resolve,
            (target) => droppedLinks.push({ entity: entity.id, target }),
          )
        : entity,
    );
    // Pair every converted entity link with its fixed inverse on the target.
    let addedInverses = 0;
    if (converting.length) {
      const byTitle = new Map(
        final.map((entity) => [entityKey(entity.id), entity]),
      );
      for (const entity of final)
        for (const { target, relationship } of entity.frontmatter.RelatedTo) {
          if (target.kind !== 'entity') continue;
          const other = byTitle.get(entityKey(target.id));
          if (!other || other === entity) continue;
          const inverse = RELATION_INVERSES[relationship];
          const relations = other.frontmatter.RelatedTo;
          if (
            relations.length >= 100 ||
            relations.some(
              (relation) =>
                relation.relationship === inverse &&
                relation.target.kind === 'entity' &&
                entityKey(relation.target.id) === entityKey(entity.id),
            )
          )
            continue;
          other.frontmatter.RelatedTo = [
            ...relations,
            {
              target: { kind: 'entity', id: entity.id },
              relationship: inverse,
            },
          ];
          addedInverses++;
        }
    }
    // Serialize everything before publishing the journal: invalid inputs leave
    // every original file untouched. Snapshots make replay independent of names.
    const snapshots = final.map((entity) => ({
      id: entity.id,
      content: serialize(entity),
    }));
    if (moves.length) {
      this.summary = {
        moved: converting.filter(({ folder }) => folder !== undefined).length,
        renamed,
        collisions,
        droppedLinks,
        addedInverses,
        dryRun: !!this.options.dryRun,
      };
      this.options.onConversionPlanned?.(structuredClone(this.summary));
    }
    // Older binaries refuse format 7 (and compatibility 4) before touching it.
    if (moves.length && !this.options.dryRun) {
      await this.options.beforeConversionWrite?.();
      await this.commit({ moves, documents: snapshots });
    }
    for (const entity of final)
      if (!this.entities.has(entityKey(entity.id)))
        this.entities.set(entityKey(entity.id), entity);
  }
}

interface LoadedDocument {
  file: string;
  entity: MemoryEntity;
  legacy: boolean;
  /** Stored before format 7; flattened on startup. */
  outdated: boolean;
  old?: LegacyFields;
  stem: string;
  /** Folder path below the memory root; absent for root-level notes. */
  folder?: string;
}

/** Historical fields used only by the forward document conversion. */
type LegacyFields = Omit<z.infer<typeof v3FrontmatterSchema>, 'FormatVersion'>;
// Journals written before format 7 (v0.38.0, format 6) hold typed nested IDs.
const journalIdSchema = z.union([entityIdSchema, typedEntityIdSchema]);
const movesJournalSchema = z
  .object({
    moves: z.array(
      z
        .object({
          from: z.string().min(1),
          to: journalIdSchema,
          path: z
            .string()
            .refine(
              (path) =>
                path.endsWith('.md') &&
                (journalIdSchema.safeParse(path.slice(0, -3)).success ||
                  legacyEntityIdSchema.safeParse(path.slice(0, -3)).success),
              'Unsafe memory source path',
            )
            .optional(),
        })
        .strict(),
    ),
    documents: z.array(
      z
        .object({ id: journalIdSchema, content: z.string().max(500_000) })
        .strict(),
    ),
  })
  .strict();
type MovesJournal = z.infer<typeof movesJournalSchema>;

function validateJournal(journal: MovesJournal): void {
  movesJournalSchema.parse(journal);
  const ids = new Set<string>();
  for (const document of journal.documents) {
    const key = entityKey(document.id);
    if (ids.has(key)) throw new Error('Duplicate journal document');
    ids.add(key);
    const { entity, legacy } = deserialize(document.content, document.id);
    if (legacy) throw new Error('Journal must contain current documents');
    if (!document.id.includes('/')) serialize(entity);
  }
  for (const move of journal.moves)
    if (!ids.has(entityKey(move.to)))
      throw new Error('Journal is missing a destination');
}

/**
 * Repoint entity targets in every predicate list. Unresolved targets stay, or
 * are dropped and reported when `onMissing` is given. Skill targets never change.
 */
function retargetRelations(
  entity: MemoryEntity,
  resolve: (id: string) => string | undefined,
  onMissing?: (target: string) => void,
): MemoryEntity {
  const relations = entity.frontmatter.RelatedTo.flatMap((relation) => {
    if (relation.target.kind !== 'entity') return [relation];
    const id = resolve(relation.target.id);
    if (id !== undefined)
      return [{ ...relation, target: { kind: 'entity' as const, id } }];
    if (!onMissing) return [relation];
    onMissing(relation.target.id);
    return [];
  });
  return {
    ...entity,
    frontmatter: {
      ...entity.frontmatter,
      RelatedTo: combineRelations(relations, [entity.id]),
    },
  };
}

/** Runtime rename/merge: relations only. A plain title in prose may mean someone else. */
function replaceReferences(
  entity: MemoryEntity,
  replacements: ReadonlyMap<string, string>,
): MemoryEntity {
  if (!replacements.size) return entity;
  return retargetRelations(entity, (id) => replacements.get(id));
}

/**
 * One-time conversion only: rewrite whole typed IDs (or legacy IDs) in facts,
 * fact history and citation labels. Never substrings, never citation IDs.
 */
function rewriteProse(
  entity: MemoryEntity,
  replacements: ReadonlyMap<string, string>,
): MemoryEntity {
  if (!replacements.size) return entity;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_/-])(?:${[...replacements.keys()]
      .sort((a, b) => b.length - a.length)
      .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})(?![\\p{L}\\p{N}_/-])`,
    'gu',
  );
  const replace = (text: string) =>
    text.replace(pattern, (match) => replacements.get(match) ?? match);
  const version = ({ text, sources }: FactVersion): FactVersion => ({
    text: replace(text),
    sources: sources.map((source) => ({
      ...source,
      label: replace(source.label),
    })),
  });
  const sections: Record<string, Fact[]> = Object.create(null);
  for (const [name, facts] of Object.entries(entity.sections))
    sections[name] = facts.map((fact) => ({
      ...version(fact),
      history: fact.history.map(version),
    }));
  return { ...entity, sections };
}

export function createEntityStore(
  directory: string,
  options: EntityStoreOptions = {},
): EntityStore {
  return new EntityStoreModule(directory, options);
}

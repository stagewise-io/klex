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
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

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
export function normalizeEntityName(value: string): string {
  let name = value
    .normalize('NFC')
    .replace(/[/\\:*?"<>|#[\]^\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 100);
  while (Buffer.byteLength(name) > 200) name = name.slice(0, -1);
  name = name.replace(/[\s.]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = `_${name}`;
  return name;
}
const entityKey = (id: string) => id.normalize('NFC').toLowerCase();
export const entityIdSchema = z
  .string()
  .max(201)
  .refine((id) => {
    const parts = id.split('/');
    return (
      parts.length === 2 &&
      entityTypeSchema.safeParse(parts[0]).success &&
      !!parts[1] &&
      parts[1].length >= 2 &&
      normalizeEntityName(parts[1]) === parts[1]
    );
  }, 'Expected type/Name, e.g. person/Ada Lovelace')
  .describe(
    'Type-qualified memory name, e.g. person/Ada Lovelace. No .md extension.',
  );
export const relationSchema = legacyRelationSchema.extend({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('entity'), id: entityIdSchema }).strict(),
    legacyRelationSchema.shape.target.options[1],
  ]),
});

export const entityFieldsSchema = z
  .object({
    name: text
      .min(2)
      .describe(
        'Canonical name as people write it. Becomes the filename; unique within its type (ignoring case). Unsafe filename/link characters become spaces. Not a description.',
      ),
    entityType: entityTypeSchema.describe(
      'Lowercase kebab-case kind the thing actually is. Reuse fitting existing type, else new. Wrong type: change it with updateEntity; its path changes and references follow.',
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
const frontmatterSchema = v3FrontmatterSchema
  .omit({ Title: true, MergedFrom: true, RelatedTo: true, FormatVersion: true })
  .extend({
    FormatVersion: z.literal(4),
    RelatedTo: z.array(relationSchema).max(100),
  });

// Retain the original document contract for forward conversion of flat notes.
const legacyFrontmatterSchema = uuidFrontmatterSchema.extend({
  FormatVersion: z.literal(1),
  EntityType: text,
});

export type EntityFields = z.input<typeof entityFieldsSchema>;
export interface MemoryEntity {
  /** Derived from the filename. */
  id: string;
  entityType: string;
  /** Derived from the file name, not stored in frontmatter. */
  name: string;
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
  .regex(/^[^\r\n#[\]<>]+$/);

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
   * relation and whole-name mention targeting `dropId`, then deletes its file.
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
    `# ${entity.name}`,
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

/** One relation per target, keeping the strongest; never to `exclude`. */
function combineRelations(
  relations: readonly Relation[],
  exclude: readonly string[] = [],
): Relation[] {
  const byTarget = new Map<string, Relation>();
  for (const relation of relations) {
    const { kind, id } = relation.target;
    if (kind === 'entity' && exclude.includes(id)) continue;
    const key = `${kind}:${id}`;
    const existing = byTarget.get(key);
    if (!existing || relation.strength > existing.strength)
      byTarget.set(key, relation);
  }
  return [...byTarget.values()];
}

/**
 * `keep` after absorbing `drop`: sections joined by name, equal facts
 * combined (sources and `was:` history kept within caps), identities,
 * matchers and relations unioned. Relations between the two vanish; for a
 * shared target the stronger relation wins. Type, title and dates stay.
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
      LinkedIdentities: identities,
      LoadOn: dedupeLoadOn(
        [...frontmatter.LoadOn, ...drop.frontmatter.LoadOn],
        keep.name,
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
  const content = `---\n${stringify(entity.frontmatter)}---\n\n${Object.entries(
    entity.sections,
  )
    .map(([name, facts]) => `## ${name}\n\n${formatFacts(facts)}`)
    .join('\n\n')}\n`;
  if (Buffer.byteLength(content) > 500_000)
    throw new Error('Entity exceeds size limit');
  return content;
}

function deserialize(
  content: string,
  id: string,
  folder?: string,
): { entity: MemoryEntity; legacy: boolean; old?: LegacyFields } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (!match?.[1] || match[2] === undefined)
    throw new Error('Missing entity frontmatter');
  const raw = parse(match[1], { maxAliasCount: 0 });
  let old: LegacyFields | undefined;
  let entityType: string;
  if (raw?.FormatVersion === 1) {
    const legacy = legacyFrontmatterSchema.parse(raw);
    if (legacy.Id !== id.split('/').at(-1))
      throw new Error('Legacy ID does not match filename');
    entityType = entityTypeSchema.parse(legacy.EntityType);
    if (folder !== undefined && folder !== entityType)
      throw new Error('Legacy entity type does not match folder');
    const {
      EntityType: _type,
      Id: _id,
      FormatVersion: _version,
      ...fields
    } = legacy;
    old = fields;
  } else {
    entityType = entityTypeSchema.parse(folder);
    if (raw?.FormatVersion !== 4) {
      const legacy = oldFrontmatterSchema.parse(raw);
      if ('Id' in legacy && legacy.Id !== id.split('/').at(-1))
        throw new Error('Legacy ID does not match filename');
      const { FormatVersion: _version, ...fields } = legacy;
      old = fields;
    }
  }
  const frontmatter = old
    ? {
        ...frontmatterSchema
          .omit({ RelatedTo: true })
          .parse({ ...old, FormatVersion: 4 }),
        RelatedTo: old.RelatedTo as Relation[],
      }
    : frontmatterSchema.parse(raw);
  const name = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
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
    entity: { id, entityType, name, frontmatter, sections },
    legacy: !!old,
    old,
  };
}

class EntityStoreModule implements EntityStore {
  private readonly entities = new Map<string, MemoryEntity>();
  private starting: Promise<void> | undefined;
  private work = Promise.resolve();
  private interrupted = false;

  constructor(private readonly directory: string) {}

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
      const entity: MemoryEntity = {
        id: this.availableId(input.entityType, input.name),
        name: normalizeEntityName(input.name),
        entityType: input.entityType,
        frontmatter: {
          FormatVersion: 4,
          CreatedAt: at,
          LastUpdatedAt: at,
          LastReadAt: null,
          LinkedIdentities: identities,
          LoadOn: dedupeLoadOn(
            input.loadOn,
            normalizeEntityName(input.name),
            identities,
          ),
          RelatedTo: input.relatedTo,
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
      entity.entityType = patch.entityType ?? entity.entityType;
      entity.name = normalizeEntityName(patch.name ?? entity.name);
      entity.id = this.availableId(entity.entityType, entity.name, previousId);
      const previous = entity.frontmatter;
      const identities = patch.linkedIdentities
        ? dedupeIdentities(patch.linkedIdentities)
        : previous.LinkedIdentities;
      this.checkIdentities(identities, previousId);
      entity.frontmatter = {
        ...previous,
        LinkedIdentities: identities,
        LoadOn: dedupeLoadOn(
          patch.loadOn ?? previous.LoadOn,
          entity.name,
          identities,
        ),
        RelatedTo: patch.relatedTo ?? previous.RelatedTo,
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
        RelatedTo: relationsSchema.parse(mutate(entity.frontmatter.RelatedTo)),
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
          `Linked identity "${formatIdentity(identity)}" already belongs to entity ${owner.id} (${owner.name}); update that entity instead`,
        );
    }
  }

  private availableId(type: string, raw: string, self?: string): string {
    const id = `${entityTypeSchema.parse(type)}/${normalizeEntityName(raw)}`;
    entityIdSchema.parse(id);
    const other = this.entities.get(entityKey(id));
    if (other && other.id !== self)
      throw new Error(
        `Entity ${other.id} already exists; update it or choose a more specific name`,
      );
    return id;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.work;
    const result = this.start().then(() =>
      previous.then(() => {
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

  private file(entity: MemoryEntity): string {
    return join(this.directory, `${entityIdSchema.parse(entity.id)}.md`);
  }

  private async persist(entity: MemoryEntity): Promise<void> {
    const content = serialize(entity);
    if (Buffer.byteLength(content) > 500_000)
      throw new Error('Entity exceeds size limit');
    await this.ensureDirectory();
    const folder = join(
      this.directory,
      entityTypeSchema.parse(entity.entityType),
    );
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (!(await lstat(folder)).isDirectory())
      throw new Error('Ontology folder must be a plain directory');
    const file = this.file(entity);
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
      this.entities.set(entityKey(entity.id), structuredClone(entity));
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
    // Delete sources before writing final snapshots. A case-only rename must
    // remove the old directory entry on case-insensitive filesystems, too.
    for (const move of journal.moves) {
      if (!move.path) continue;
      const file = join(this.directory, move.path);
      const parent = dirname(file);
      const stat = await lstat(parent);
      if (!stat.isDirectory())
        throw new Error('Memory source must be a plain directory');
      if (
        (await readdir(parent)).some(
          (name) => name.normalize('NFC') === basename(file).normalize('NFC'),
        )
      )
        await rm(file);
    }
    for (const document of journal.documents) {
      const { entity } = deserialize(
        document.content,
        document.id,
        document.id.split('/')[0],
      );
      await this.persist(entity);
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
      next.set(
        entityKey(id),
        deserialize(content, id, id.split('/')[0]).entity,
      );
    const documents: MovesJournal['documents'] = [];
    for (const entity of next.values()) {
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
        const { entity, legacy, old } = deserialize(content, id, folder);
        if (!legacy) entityIdSchema.parse(id);
        else legacyEntityIdSchema.parse(stem);
        const key = legacy ? stem : entityKey(id);
        if (ids.has(key)) throw new Error('Duplicate entity identity');
        ids.add(key);
        documents.push({ file, entity, legacy, old, stem });
      } catch (error) {
        throw new Error(`Invalid entity ${file}`, { cause: error });
      } finally {
        await handle.close();
      }
    };
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      const file = join(this.directory, entry.name);
      if (entry.isDirectory()) {
        entityTypeSchema.parse(entry.name);
        for (const note of await readdir(file, { withFileTypes: true })) {
          if (!note.name.endsWith('.md')) continue;
          if (!note.isFile()) throw new Error('Entity must be a regular file');
          await readDocument(join(file, note.name), note.name, entry.name);
        }
      } else if (entry.name.endsWith('.md')) {
        if (!entry.isFile()) throw new Error('Entity must be a regular file');
        await readDocument(file, entry.name);
      } else if (entry.isSymbolicLink()) {
        throw new Error('Ontology folder must be a plain directory');
      }
    }
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
    const used = new Set(
      active
        .filter(({ legacy }) => !legacy)
        .map(({ entity }) => entityKey(entity.id)),
    );
    const replacements = new Map<string, string>();
    const moves: MovesJournal['moves'] = [];
    for (const document of active.sort((a, b) =>
      a.file.localeCompare(b.file),
    )) {
      const { entity, old, stem } = document;
      if (!old) continue;
      const base = normalizeEntityName(old.Title);
      const name = base.length >= 2 ? base : 'Untitled';
      let candidate = `${entity.entityType}/${name}`;
      for (let suffix = 2; used.has(entityKey(candidate)); suffix++)
        candidate = `${entity.entityType}/${normalizeEntityName(name.slice(0, 95))} ${suffix}`;
      used.add(entityKey(candidate));
      replacements.set(stem, candidate);
      moves.push({
        from: stem,
        to: candidate,
        path: relative(this.directory, document.file),
      });
      entity.id = candidate;
      entity.name = candidate.slice(candidate.indexOf('/') + 1);
    }
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
        path: relative(this.directory, document.file),
      });
    }
    const final = active.map(({ entity }) =>
      replaceReferences(entity, replacements),
    );
    // Serialize everything before publishing the journal: invalid inputs leave
    // every original file untouched. Snapshots make replay independent of names.
    const snapshots = final.map((entity) => ({
      id: entity.id,
      content: serialize(entity),
    }));
    if (moves.length) await this.commit({ moves, documents: snapshots });
    else
      for (const entity of final)
        this.entities.set(entityKey(entity.id), entity);
  }
}

interface LoadedDocument {
  file: string;
  entity: MemoryEntity;
  legacy: boolean;
  old?: LegacyFields;
  stem: string;
}

/** Historical fields used only by the forward document conversion. */
type LegacyFields = Omit<z.infer<typeof v3FrontmatterSchema>, 'FormatVersion'>;
const movesJournalSchema = z
  .object({
    moves: z.array(
      z
        .object({
          from: z.string().min(1),
          to: entityIdSchema,
          path: z
            .string()
            .regex(/^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/)?[^/\\]+\.md$/)
            .refine(
              (path) =>
                !path.split('/').some((part) => part === '.' || part === '..'),
            )
            .optional(),
        })
        .strict(),
    ),
    documents: z.array(
      z
        .object({ id: entityIdSchema, content: z.string().max(500_000) })
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
    const { entity, legacy } = deserialize(
      document.content,
      document.id,
      document.id.split('/')[0],
    );
    if (legacy) throw new Error('Journal must contain current documents');
    serialize(entity);
  }
  for (const move of journal.moves)
    if (!ids.has(entityKey(move.to)))
      throw new Error('Journal is missing a destination');
}

/**
 * Rewrite qualified names (or legacy IDs) in links, facts, and fact history.
 * Match whole references, never substrings, and never rewrite citation IDs.
 */
function replaceReferences(
  entity: MemoryEntity,
  replacements: ReadonlyMap<string, string>,
): MemoryEntity {
  if (!replacements.size) return entity;
  const id = entity.id;
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
  const { RelatedTo, ...frontmatter } = entity.frontmatter;
  return {
    ...entity,
    id,
    sections,
    frontmatter: {
      ...frontmatter,
      RelatedTo: RelatedTo.some(
        ({ target }) => target.kind === 'entity' && replacements.has(target.id),
      )
        ? combineRelations(
            RelatedTo.map((relation) =>
              relation.target.kind === 'entity' &&
              replacements.has(relation.target.id)
                ? {
                    ...relation,
                    target: {
                      kind: 'entity',
                      id:
                        replacements.get(relation.target.id) ??
                        relation.target.id,
                    },
                  }
                : relation,
            ),
            [id],
          )
        : RelatedTo,
    },
  };
}

export function createEntityStore(directory: string): EntityStore {
  return new EntityStoreModule(directory);
}

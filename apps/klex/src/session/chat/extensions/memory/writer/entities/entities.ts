import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { parseSkillId } from '@/skills';
import {
  LOW_TOKEN_ID_MAX_LENGTH,
  LOW_TOKEN_ID_MIN_LENGTH,
  randomLowTokenID,
} from '@/utils/random-low-token-id';

import { type Fact, formatFacts, parseFacts } from './facts';

const wordIdSchema = z
  .string()
  .min(LOW_TOKEN_ID_MIN_LENGTH)
  .max(LOW_TOKEN_ID_MAX_LENGTH)
  .regex(/^(?:[a-z]+|(?:[A-Z][a-z]+){3})$/);
const text = z.string().trim().min(1).max(200);
export const entityIdSchema = z
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
export const relationSchema = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('entity'), id: entityIdSchema }).strict(),
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

export const entityFieldsSchema = z
  .object({
    title: text
      .min(2)
      .describe(
        'Short canonical name, key or handle. Not a description; not a trigger.',
      ),
    entityType: entityTypeSchema.describe(
      'Lowercase kebab-case kind the thing actually is. Reuse fitting existing type, else new. Update moves file; ID kept.',
    ),
    loadOn: z
      .array(loadMatcherSchema)
      .max(50)
      .default([])
      .describe(
        'Dedicated auto-load triggers; any one fires. Title and LinkedIdentities already trigger; never repeat them.',
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
const currentFrontmatterSchema = z.object({
  FormatVersion: z.literal(3),
  Title: text.min(2),
  CreatedAt: z.iso.datetime(),
  LastUpdatedAt: z.iso.datetime(),
  LastReadAt: z.iso.datetime().nullable(),
  LinkedIdentities: z.array(linkedIdentitySchema).max(30).default([]),
  LoadOn: storedLoadOnSchema,
  RelatedTo: z.array(relationSchema).max(100),
  TrustScore: z.literal(2),
  AuthorityScore: z.literal(5),
});

// Preserve existing UUID documents without rewriting their identities or references.
const uuidFrontmatterSchema = z.object({
  FormatVersion: z.literal(2),
  Id: z.uuid(),
  ...currentFrontmatterSchema.omit({ FormatVersion: true }).shape,
});
const frontmatterSchema = z.union([
  currentFrontmatterSchema,
  uuidFrontmatterSchema,
]);

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
  /** Environment-only API. Never exposed to the writer's tools. */
  recordRead(id: string): Promise<void>;
}

/** Main-session view: current facts only, no citations or superseded versions. */
export function renderEntity(
  entity: MemoryEntity,
  requestedSections: readonly string[] = [],
): string {
  const identities = entity.frontmatter.LinkedIdentities;
  return [
    `# ${entity.frontmatter.Title}`,
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
  validateSections(entity.sections);
  return `---\n${stringify(entity.frontmatter)}---\n\n${Object.entries(
    entity.sections,
  )
    .map(([name, facts]) => `## ${name}\n\n${formatFacts(facts)}`)
    .join('\n\n')}\n`;
}

function deserialize(
  content: string,
  id: string,
  folder?: string,
): { entity: MemoryEntity; legacy: boolean } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (!match?.[1] || match[2] === undefined)
    throw new Error('Missing entity frontmatter');
  const raw = parse(match[1], { maxAliasCount: 0 });
  let frontmatter: MemoryEntity['frontmatter'];
  let entityType: string;
  if (raw?.FormatVersion === 1) {
    const legacy = legacyFrontmatterSchema.parse(raw);
    entityType = entityTypeSchema.parse(legacy.EntityType);
    if (folder !== undefined && folder !== entityType)
      throw new Error('Legacy entity type does not match folder');
    const { EntityType: _type, ...fields } = legacy;
    frontmatter = { ...fields, FormatVersion: 2 };
  } else {
    frontmatter = frontmatterSchema.parse(raw);
    entityType = entityTypeSchema.parse(folder);
  }
  if ('Id' in frontmatter && frontmatter.Id !== id)
    throw new Error('Entity identity does not match filename');
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
    entity: { id, entityType, frontmatter, sections },
    legacy: raw.FormatVersion === 1,
  };
}

class EntityStoreModule implements EntityStore {
  private readonly entities = new Map<string, MemoryEntity>();
  private starting: Promise<void> | undefined;
  private work = Promise.resolve();

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
    return structuredClone(this.entities.get(id) ?? null);
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
        id: this.allocateId(),
        entityType: input.entityType,
        frontmatter: {
          FormatVersion: 3,
          Title: input.title,
          CreatedAt: at,
          LastUpdatedAt: at,
          LastReadAt: null,
          LinkedIdentities: identities,
          LoadOn: dedupeLoadOn(input.loadOn, input.title, identities),
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
      entity.entityType = patch.entityType ?? entity.entityType;
      const previous = entity.frontmatter;
      const identities = patch.linkedIdentities
        ? dedupeIdentities(patch.linkedIdentities)
        : previous.LinkedIdentities;
      this.checkIdentities(identities, id);
      const title = patch.title ?? previous.Title;
      entity.frontmatter = {
        ...previous,
        Title: title,
        LinkedIdentities: identities,
        LoadOn: dedupeLoadOn(
          patch.loadOn ?? previous.LoadOn,
          title,
          identities,
        ),
        RelatedTo: patch.relatedTo ?? previous.RelatedTo,
        LastUpdatedAt: new Date().toISOString(),
      };
      await this.persist(entity);
      return structuredClone(entity);
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
          `Linked identity "${formatIdentity(identity)}" already belongs to entity ${owner.id} (${owner.frontmatter.Title}); update that entity instead`,
        );
    }
  }

  private allocateId(): string {
    // Check serialized identity, not word tuple: concatenation is ambiguous.
    // Called only inside the store's serialized creation queue.
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = randomLowTokenID();
      if (
        ![...this.entities.keys()].some(
          (existing) => existing.toLowerCase() === id.toLowerCase(),
        )
      )
        return id;
    }
    throw new Error('Could not allocate a unique entity ID after 100 attempts');
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.work;
    const result = this.start().then(() => previous.then(action));
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
    const previous = this.entities.get(entity.id);
    const file = join(folder, `${entity.id}.md`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      if (previous && previous.entityType !== entity.entityType) {
        // Move first: if interrupted before rewriting, the old valid document
        // remains at the new folder and startup derives its type from that path.
        const oldFolder = join(this.directory, previous.entityType);
        if (!(await lstat(oldFolder)).isDirectory())
          throw new Error('Ontology folder must be a plain directory');
        const oldFile = join(oldFolder, `${entity.id}.md`);
        await rename(oldFile, file);
        try {
          await rename(temporary, file);
        } catch (error) {
          await rename(file, oldFile);
          throw error;
        }
      } else {
        await rename(temporary, file);
      }
      this.entities.set(entity.id, structuredClone(entity));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async load(): Promise<void> {
    await this.ensureDirectory();
    const documents: { file: string; entity: MemoryEntity; legacy: boolean }[] =
      [];
    const ids = new Set<string>();
    const readDocument = async (
      file: string,
      name: string,
      folder?: string,
    ) => {
      const id = entityIdSchema.parse(name.slice(0, -3));
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
        const { entity, legacy } = deserialize(content, id, folder);
        if (ids.has(id)) throw new Error('Duplicate entity identity');
        ids.add(id);
        documents.push({ file, entity, legacy });
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
    // Validate all notes before converting any. Renaming before rewriting lets
    // startup resume a conversion interrupted between those two atomic steps.
    for (const { file, entity, legacy } of documents) {
      if (legacy) {
        const folder = join(this.directory, entity.entityType);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        if (!(await lstat(folder)).isDirectory())
          throw new Error('Ontology folder must be a plain directory');
        const target = join(folder, `${entity.id}.md`);
        if (target !== file) await rename(file, target);
        await this.persist(entity);
      } else {
        this.entities.set(entity.id, entity);
      }
    }
  }
}

export function createEntityStore(directory: string): EntityStore {
  return new EntityStoreModule(directory);
}

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

const text = z.string().trim().min(1).max(200);
export const entityIdSchema = z.uuid();
const entityTypeSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const conditionSchema = z
  .object({
    path: text.describe(
      'Dot-separated attribute path, e.g. metadata.conversationId.',
    ),
    match: z.enum(['exact', 'fuzzy']),
    value: z.union([z.string().min(1).max(500), z.number(), z.boolean()]),
  })
  .strict();

/** Conditions within one matcher are ANDed; separate LoadOn entries are ORed. */
export const loadMatcherSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('contentPattern'),
      pattern: z.string().trim().min(2).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal('pushNotificationMetadataPattern'),
      conditions: z.array(conditionSchema).min(1).max(30),
    })
    .strict(),
  z
    .object({
      type: z.literal('toolCallPattern'),
      mcpServer: text.optional(),
      toolName: text.optional(),
      arguments: z.array(conditionSchema).max(30).default([]),
    })
    .strict()
    .refine(
      (matcher) =>
        Boolean(
          matcher.mcpServer || matcher.toolName || matcher.arguments.length,
        ),
      'Specify a server, tool, or argument condition',
    ),
]);
export const relationSchema = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('entity'), id: entityIdSchema }).strict(),
      z
        .object({
          kind: z.literal('skill'),
          id: z.string().regex(/^learning\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
        })
        .strict(),
    ]),
    strength: z.number().int().min(0).max(100),
    relationship: text,
  })
  .strict();

export const entityFieldsSchema = z
  .object({
    title: text.min(2),
    entityType: entityTypeSchema.describe(
      'Ontology folder: a lowercase kebab-case name. Suggested: person, project, organization, place, topic, event. New folders are allowed. Updating this moves the document without changing its ID.',
    ),
    loadOn: z.array(loadMatcherSchema).max(50).default([]),
    relatedTo: z.array(relationSchema).max(100).default([]),
  })
  .strict();

/** Patch omission must preserve collections, not apply create-time defaults. */
export const entityPatchSchema = entityFieldsSchema.partial().extend({
  loadOn: entityFieldsSchema.shape.loadOn.removeDefault().optional(),
  relatedTo: entityFieldsSchema.shape.relatedTo.removeDefault().optional(),
});

const frontmatterSchema = z
  .object({
    FormatVersion: z.literal(2),
    Id: entityIdSchema,
    Title: text.min(2),
    CreatedAt: z.iso.datetime(),
    LastUpdatedAt: z.iso.datetime(),
    LastReadAt: z.iso.datetime().nullable(),
    LoadOn: z.array(loadMatcherSchema).min(1).max(51),
    RelatedTo: z.array(relationSchema).max(100),
    TrustScore: z.literal(2),
    AuthorityScore: z.literal(5),
  })
  .strict();

// Retain the original document contract for forward conversion of flat notes.
const legacyFrontmatterSchema = frontmatterSchema.extend({
  FormatVersion: z.literal(1),
  EntityType: text,
});

export type EntityFields = z.infer<typeof entityFieldsSchema>;
export interface MemoryEntity {
  entityType: string;
  frontmatter: z.infer<typeof frontmatterSchema>;
  sections: Record<string, string>;
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
    sections: Record<string, string>,
  ): Promise<MemoryEntity>;
  update(
    id: string,
    fields: Partial<EntityFields>,
    sections: Record<string, string>,
    removeSections?: string[],
    expectedRevision?: string,
  ): Promise<MemoryEntity>;
  /** Environment-only API. Never exposed to the writer's tools. */
  recordRead(id: string): Promise<void>;
}

/** Strip canonical source handles before exposing factual memory to a main session. */
export function renderEntity(
  entity: MemoryEntity,
  requestedSections: readonly string[] = [],
): string {
  return [
    `# ${entity.frontmatter.Title}`,
    ...Object.entries(entity.sections)
      .filter(
        ([name]) => name === 'General' || requestedSections.includes(name),
      )
      .map(
        ([name, content]) =>
          `## ${name}\n${content.replace(/\[([^\]\n]*)\]\(history:[A-Za-z0-9_-]+\)/g, '$1')}`,
      ),
  ].join('\n\n');
}

function normalizeLoadOn(
  title: string,
  matchers: EntityFields['loadOn'],
): EntityFields['loadOn'] {
  return [
    { type: 'contentPattern', pattern: title },
    ...matchers.filter(
      (matcher) =>
        matcher.type !== 'contentPattern' || matcher.pattern !== title,
    ),
  ];
}

function validateSections(sections: Record<string, string>): void {
  for (const [name, content] of Object.entries(sections)) {
    sectionNameSchema.parse(name);
    if (
      typeof content !== 'string' ||
      !content.trim() ||
      content.length > 40_000 ||
      /^##\s/m.test(content)
    )
      throw new Error('Invalid section content');
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
    .map(([name, content]) => `## ${name}\n\n${content}`)
    .join('\n\n')}\n`;
}

function deserialize(
  content: string,
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
  const sections: Record<string, string> = Object.create(null);
  for (const section of match[2].split(/^## /m).slice(1)) {
    const line = section.indexOf('\n');
    const name = section.slice(0, line).trim();
    if (Object.hasOwn(sections, name)) throw new Error('Duplicate section');
    sections[name] = section.slice(line + 1).trim();
  }
  validateSections(sections);
  return {
    entity: { entityType, frontmatter, sections },
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
    sections: Record<string, string>,
  ): Promise<MemoryEntity> {
    const input = entityFieldsSchema.parse(fields);
    return this.enqueue(async () => {
      const at = new Date().toISOString();
      const entity: MemoryEntity = {
        entityType: input.entityType,
        frontmatter: {
          FormatVersion: 2,
          Id: randomUUID(),
          Title: input.title,
          CreatedAt: at,
          LastUpdatedAt: at,
          LastReadAt: null,
          LoadOn: normalizeLoadOn(input.title, input.loadOn),
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
    sections: Record<string, string>,
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
      entity.frontmatter = {
        ...previous,
        Title: patch.title ?? previous.Title,
        LoadOn: normalizeLoadOn(
          patch.title ?? previous.Title,
          patch.loadOn ??
            previous.LoadOn.filter(
              (matcher) =>
                matcher.type !== 'contentPattern' ||
                matcher.pattern !== previous.Title,
            ),
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
    const previous = this.entities.get(entity.frontmatter.Id);
    const file = join(folder, `${entity.frontmatter.Id}.md`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      if (previous && previous.entityType !== entity.entityType) {
        // Move first: if interrupted before rewriting, the old valid document
        // remains at the new folder and startup derives its type from that path.
        const oldFolder = join(this.directory, previous.entityType);
        if (!(await lstat(oldFolder)).isDirectory())
          throw new Error('Ontology folder must be a plain directory');
        const oldFile = join(oldFolder, `${entity.frontmatter.Id}.md`);
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
      this.entities.set(entity.frontmatter.Id, structuredClone(entity));
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
        const { entity, legacy } = deserialize(content, folder);
        if (entity.frontmatter.Id !== id)
          throw new Error('Entity identity does not match filename');
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
        const target = join(folder, `${entity.frontmatter.Id}.md`);
        if (target !== file) await rename(file, target);
        await this.persist(entity);
      } else {
        this.entities.set(entity.frontmatter.Id, entity);
      }
    }
  }
}

export function createEntityStore(directory: string): EntityStore {
  return new EntityStoreModule(directory);
}

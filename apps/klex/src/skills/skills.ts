import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModuleLogger } from '@stagewise/logger';

import {
  createRegistryFile,
  type RegistryFile,
  SKILLS_DIRECTORY,
  type StoredSkillUsage,
} from './registry-store';
import {
  createSkillDocumentStore,
  type SkillDocumentStore,
} from './skill-files';
import {
  formatSkillId,
  isValidSkillName,
  isValidSkillNamespace,
  parseSkillId,
  type SkillDocument,
  validateSkill,
} from './skill-format';
import { MAX_METADATA_BYTES, RESERVED_SKILL_NAMESPACES } from './skills-config';

/** Rejected skill input; the message is safe to show to callers. */
export class SkillValidationError extends Error {}

/** Core bookkeeping of one skill. Dates serve UIs; turns serve relevance. */
export interface SkillUsage {
  createdAt: string;
  /** Moves only when description or body change. */
  updatedAt: string;
  lastReadAt: string | null;
  readCount: number;
  /** Agent turn positions, see {@link SkillRegistry.currentTurn}. */
  createdTurn: number;
  updatedTurn: number;
  lastReadTurn: number | null;
  /** True after an admin content change; reset by a namespace content write. Grants no protection. */
  userEdited: boolean;
  /** Namespace-owned JSON object. */
  metadata: Record<string, unknown>;
}

export interface Skill extends SkillDocument, SkillUsage {
  /** Qualified id `namespace/name`. */
  id: string;
  /** Source of the skill: the namespace of its contributor. */
  namespace: string;
}

export interface SkillContent {
  description: string;
  body: string;
}

export type SkillPatch = Partial<SkillContent>;

/** Initial usage for imported skills; applied only when the skill is created. */
export interface SkillSeed {
  createdAt?: string;
  updatedAt?: string;
  lastReadAt?: string | null;
  readCount?: number;
  userEdited?: boolean;
}

export interface SkillPutOptions {
  /** Replaces the namespace-owned metadata when given. */
  metadata?: Record<string, unknown>;
  seed?: SkillSeed;
  /** Rejects when bookkeeping cannot be persisted; the document stays written. */
  durable?: boolean;
}

/** Read/write access to one namespace, handed to its owning extension. */
export interface SkillNamespaceHandle {
  readonly namespace: string;
  list(): readonly Skill[];
  get(name: string): Skill | null;
  /** Creates or replaces a skill. Identical content does not count as a change. */
  put(
    name: string,
    content: SkillContent,
    options?: SkillPutOptions,
  ): Promise<Skill>;
  /** Replaces metadata without touching content or `updated*`; null when unknown. */
  setMetadata(
    name: string,
    metadata: Record<string, unknown>,
  ): Promise<Skill | null>;
  delete(name: string): Promise<boolean>;
  currentTurn(): number;
}

/** Agent-wide skills: documents under `skills/{namespace}/{name}/SKILL.md`. */
export interface SkillRegistry {
  start(): Promise<void>;
  /** Flushes the activity clock. */
  close(): Promise<void>;
  /** All skills, sorted by id. */
  list(): readonly Skill[];
  get(id: string): Skill | null;
  /** Full `SKILL.md` content. */
  read(id: string): string | null;
  /** All skills with this bare name, sorted by id. */
  resolveName(name: string): readonly Skill[];
  /** Admin content change; sets `userEdited`. Null when unknown. */
  update(id: string, patch: SkillPatch): Promise<Skill | null>;
  delete(id: string): Promise<boolean>;
  recordRead(id: string): Promise<void>;
  /** Advances the agent activity clock by one turn; persisted lazily. */
  tick(): void;
  currentTurn(): number;
  /** Throws for invalid, reserved, or foreign-owned namespaces; idempotent per owner. */
  claimNamespace(extensionIdentifier: string, namespace: string): void;
  /** Handle for a claimed namespace. */
  forNamespace(namespace: string): SkillNamespaceHandle;
}

export interface SkillRegistryOptions {
  dataDirectory: string;
  logger: ModuleLogger;
}

class SkillRegistryModule implements SkillRegistry {
  private readonly root: string;
  private readonly file: RegistryFile;
  private readonly namespaces = new Map<string, SkillDocumentStore>();
  private readonly claims = new Map<string, string>();
  private readonly handles = new Map<string, SkillNamespaceHandle>();
  private records: Record<string, StoredSkillUsage> = {};
  /** Records created in memory for documents without persisted bookkeeping. */
  private readonly synthesized = new Set<string>();
  private unknownFields: Record<string, unknown> = {};
  private turn = 0;
  private turnDirty = false;
  private startPromise: Promise<void> | undefined;
  private work: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SkillRegistryOptions) {
    this.root = join(options.dataDirectory, SKILLS_DIRECTORY);
    this.file = createRegistryFile(options.dataDirectory);
  }

  start(): Promise<void> {
    this.startPromise ??= this.load();
    return this.startPromise;
  }

  async close(): Promise<void> {
    if (!this.startPromise) return;
    await this.enqueue(async () => {
      if (this.turnDirty) await this.persist();
    });
  }

  list(): readonly Skill[] {
    const skills: Skill[] = [];
    for (const namespace of [...this.namespaces.keys()].sort()) {
      skills.push(...this.listNamespace(namespace));
    }
    return skills;
  }

  get(id: string): Skill | null {
    const parsed = parseSkillId(id);
    if (!parsed) return null;
    return this.getSkill(parsed.namespace, parsed.name);
  }

  read(id: string): string | null {
    const parsed = parseSkillId(id);
    if (!parsed) return null;
    return this.namespaces.get(parsed.namespace)?.read(parsed.name) ?? null;
  }

  resolveName(name: string): readonly Skill[] {
    if (!isValidSkillName(name)) return [];
    return [...this.namespaces.keys()]
      .sort()
      .map((namespace) => this.getSkill(namespace, name))
      .filter((skill): skill is Skill => skill !== null);
  }

  update(id: string, patch: SkillPatch): Promise<Skill | null> {
    return this.enqueue(async () => {
      const parsed = parseSkillId(id);
      if (!parsed) return null;
      const store = this.namespaces.get(parsed.namespace);
      const existing = store?.get(parsed.name);
      if (!store || !existing) return null;
      const next = normalize({
        name: existing.name,
        description: patch.description ?? existing.description,
        body: patch.body ?? existing.body,
      });
      const changed = !sameContent(existing, next);
      if (!changed) return this.getSkill(parsed.namespace, parsed.name);
      await store.write(next);
      const record = this.ensureRecord(id);
      record.updatedAt = new Date().toISOString();
      record.updatedTurn = this.turn;
      record.userEdited = true;
      await this.persistSafely();
      return this.getSkill(parsed.namespace, parsed.name);
    });
  }

  delete(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const parsed = parseSkillId(id);
      if (!parsed) return false;
      return this.deleteSkill(parsed.namespace, parsed.name);
    });
  }

  recordRead(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.get(id)) return;
      const record = this.ensureRecord(id);
      record.lastReadAt = new Date().toISOString();
      record.lastReadTurn = this.turn;
      record.readCount += 1;
      await this.persistSafely();
    });
  }

  tick(): void {
    this.turn += 1;
    this.turnDirty = true;
  }

  currentTurn(): number {
    return this.turn;
  }

  claimNamespace(extensionIdentifier: string, namespace: string): void {
    assertNamespace(namespace);
    const owner = this.claims.get(namespace);
    if (owner !== undefined && owner !== extensionIdentifier) {
      throw new Error(
        `Skill namespace "${namespace}" is already claimed by "${owner}"`,
      );
    }
    this.claims.set(namespace, extensionIdentifier);
  }

  forNamespace(namespace: string): SkillNamespaceHandle {
    if (!this.claims.has(namespace)) {
      throw new Error(`Skill namespace "${namespace}" is not claimed`);
    }
    let handle = this.handles.get(namespace);
    if (!handle) {
      handle = this.createHandle(namespace);
      this.handles.set(namespace, handle);
    }
    return handle;
  }

  private createHandle(namespace: string): SkillNamespaceHandle {
    return {
      namespace,
      list: () => this.listNamespace(namespace),
      get: (name) => this.getSkill(namespace, name),
      put: (name, content, options) =>
        this.enqueue(() => this.putSkill(namespace, name, content, options)),
      setMetadata: (name, metadata) =>
        this.enqueue(() => this.setSkillMetadata(namespace, name, metadata)),
      delete: (name) => this.enqueue(() => this.deleteSkill(namespace, name)),
      currentTurn: () => this.turn,
    };
  }

  private async putSkill(
    namespace: string,
    name: string,
    content: SkillContent,
    options: SkillPutOptions = {},
  ): Promise<Skill> {
    const next = normalize({ name, ...content });
    const metadata =
      options.metadata === undefined
        ? undefined
        : normalizeMetadata(options.metadata);
    const store = await this.storeFor(namespace);
    const existing = store.get(name);
    const id = formatSkillId(namespace, name);
    const changed = !existing || !sameContent(existing, next);
    if (changed) await store.write(next);

    // A document without persisted bookkeeping counts as new, so a re-run
    // after a crash between document and bookkeeping write keeps its seed.
    const seeded =
      !existing || !Object.hasOwn(this.records, id) || this.synthesized.has(id);
    const at = new Date().toISOString();
    const record = seeded
      ? this.createRecord(id, at, options.seed)
      : this.ensureRecord(id);
    let dirty = seeded;
    if (existing && changed) {
      record.updatedAt = at;
      record.updatedTurn = this.turn;
      record.userEdited = false;
      dirty = true;
    }
    if (metadata !== undefined && !sameJson(record.metadata, metadata)) {
      record.metadata = metadata;
      dirty = true;
    }
    if (options.durable) await this.persist();
    else if (dirty) await this.persistSafely();
    return this.getSkill(namespace, name) as Skill;
  }

  private async setSkillMetadata(
    namespace: string,
    name: string,
    metadata: Record<string, unknown>,
  ): Promise<Skill | null> {
    if (!this.namespaces.get(namespace)?.get(name)) return null;
    const normalized = normalizeMetadata(metadata);
    const record = this.ensureRecord(formatSkillId(namespace, name));
    if (!sameJson(record.metadata, normalized)) {
      record.metadata = normalized;
      await this.persistSafely();
    }
    return this.getSkill(namespace, name);
  }

  private async deleteSkill(namespace: string, name: string): Promise<boolean> {
    const store = this.namespaces.get(namespace);
    if (!store?.get(name)) return false;
    await store.delete(name);
    const id = formatSkillId(namespace, name);
    delete this.records[id];
    this.synthesized.delete(id);
    await this.persistSafely();
    return true;
  }

  private listNamespace(namespace: string): Skill[] {
    const store = this.namespaces.get(namespace);
    if (!store) return [];
    return store.list().map((document) => this.toSkill(namespace, document));
  }

  private getSkill(namespace: string, name: string): Skill | null {
    const document = this.namespaces.get(namespace)?.get(name);
    return document ? this.toSkill(namespace, document) : null;
  }

  private toSkill(namespace: string, document: SkillDocument): Skill {
    const id = formatSkillId(namespace, document.name);
    const record = this.ensureRecord(id);
    return {
      id,
      namespace,
      name: document.name,
      description: document.description,
      body: document.body,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastReadAt: record.lastReadAt,
      readCount: record.readCount,
      createdTurn: record.createdTurn,
      updatedTurn: record.updatedTurn,
      lastReadTurn: record.lastReadTurn,
      userEdited: record.userEdited,
      metadata: structuredClone(record.metadata),
    };
  }

  /** Bookkeeping for an existing document, created lazily when missing. */
  private ensureRecord(id: string): StoredSkillUsage {
    const existing = Object.hasOwn(this.records, id)
      ? this.records[id]
      : undefined;
    if (existing) return existing;
    const record = this.createRecord(id, new Date().toISOString());
    this.synthesized.add(id);
    return record;
  }

  private createRecord(
    id: string,
    at: string,
    seed: SkillSeed = {},
  ): StoredSkillUsage {
    const createdAt = seed.createdAt ?? at;
    const record: StoredSkillUsage = {
      createdAt,
      updatedAt: seed.updatedAt ?? createdAt,
      lastReadAt: seed.lastReadAt ?? null,
      readCount: seed.readCount ?? 0,
      createdTurn: this.turn,
      updatedTurn: this.turn,
      lastReadTurn: seed.lastReadAt ? this.turn : null,
      userEdited: seed.userEdited ?? false,
      metadata: {},
    };
    this.records[id] = record;
    this.synthesized.delete(id);
    return record;
  }

  private async storeFor(namespace: string): Promise<SkillDocumentStore> {
    let store = this.namespaces.get(namespace);
    if (!store) {
      store = this.createStore(namespace);
      this.namespaces.set(namespace, store);
    }
    await store.start();
    return store;
  }

  private createStore(namespace: string): SkillDocumentStore {
    return createSkillDocumentStore(
      join(this.root, namespace),
      this.options.logger,
    );
  }

  private async load(): Promise<void> {
    const document = await this.file.load();
    if (document) {
      const { turn, skills, ...unknownFields } = document;
      this.turn = turn;
      this.records = { ...skills };
      this.unknownFields = unknownFields;
    }
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isValidSkillNamespace(entry.name)) {
        this.options.logger.warn(
          { namespace: entry.name },
          'Skipping skill folder with an invalid namespace',
        );
        continue;
      }
      const store = this.createStore(entry.name);
      await store.start();
      this.namespaces.set(entry.name, store);
    }
  }

  /** Files are the source of truth: bookkeeping failures are logged only. */
  private async persistSafely(): Promise<void> {
    try {
      await this.persist();
    } catch (error) {
      this.options.logger.warn({ error }, 'Writing skill bookkeeping failed');
    }
  }

  private async persist(): Promise<void> {
    const skills: Record<string, StoredSkillUsage> = {};
    for (const [id, record] of Object.entries(this.records)) {
      const parsed = parseSkillId(id);
      if (parsed && this.namespaces.get(parsed.namespace)?.get(parsed.name)) {
        skills[id] = record;
      }
    }
    this.records = skills;
    const turn = this.turn;
    await this.file.save({ ...this.unknownFields, turn, skills });
    this.synthesized.clear();
    if (this.turn === turn) this.turnDirty = false;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.work;
    const result = this.start().then(() => previous.then(action, action));
    this.work = result.catch(() => undefined);
    return result;
  }
}

function normalize(document: SkillDocument): SkillDocument {
  const next = {
    name: document.name,
    description: document.description.trim(),
    body: document.body.trim(),
  };
  const reason = validateSkill(next);
  if (reason) throw new SkillValidationError(reason);
  return next;
}

function sameContent(left: SkillDocument, right: SkillDocument): boolean {
  return left.description === right.description && left.body === right.body;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertNamespace(namespace: string): void {
  if (!isValidSkillNamespace(namespace)) {
    throw new Error(`Invalid skill namespace "${namespace}"`);
  }
  if (RESERVED_SKILL_NAMESPACES.includes(namespace)) {
    throw new Error(`Skill namespace "${namespace}" is reserved`);
  }
}

/** Validates metadata and returns its JSON round-tripped copy. */
function normalizeMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new SkillValidationError('metadata must be a JSON object');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    throw new SkillValidationError('metadata is not JSON-serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
    throw new SkillValidationError('metadata too large');
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

export function createSkillRegistry(
  options: SkillRegistryOptions,
): SkillRegistry {
  return new SkillRegistryModule(options);
}

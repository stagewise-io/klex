import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createLogger } from '@stagewise/logger';

import type { AdminApi } from '@/admin-api';
import { parseCliArgs } from '@/cli';
import { CONFIG_STORE_DEFINITION, klexConfigSchema } from '@/config';
import { writeJsonStoreDocument } from '@/local-data';
import { createLogStore } from '@/log-store';
import { KLEX_VERSION } from '@/release';
import type { SessionHistory } from '@/session-history';

import { type Application, createApplication } from './application';

const observed = vi.hoisted(() => ({
  admin: undefined as AdminApi | undefined,
  history: undefined as SessionHistory | undefined,
  forbiddenArchive: '',
  archiveAccesses: [] as string[],
}));

// Keep the real API, runtime, history, providers, extensions and migrations.
// Capture the in-process API instead of exposing an unauthenticated listener.
vi.mock('@/session-history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session-history')>();
  return {
    ...actual,
    createSessionHistory: (
      deps: Parameters<typeof actual.createSessionHistory>[0],
    ) => {
      observed.history = actual.createSessionHistory(deps);
      return observed.history;
    },
  };
});
vi.mock('@/admin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/admin-api')>();
  return {
    ...actual,
    createAdminApi: (deps: Parameters<typeof actual.createAdminApi>[0]) => {
      observed.admin = actual.createAdminApi(deps);
      return observed.admin;
    },
  };
});
vi.mock('@/cli-ui', () => ({
  createCliUi: () => {
    throw new Error('Headless acceptance must not create a UI');
  },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const guarded = { ...actual };
  for (const method of [
    'access',
    'mkdir',
    'open',
    'readFile',
    'readdir',
    'stat',
    'writeFile',
  ] as const) {
    guarded[method] = ((...args: unknown[]) => {
      const path = String(args[0]);
      if (
        observed.forbiddenArchive &&
        (path === observed.forbiddenArchive ||
          path.startsWith(`${observed.forbiddenArchive}/`))
      ) {
        observed.archiveAccesses.push(`${method}: ${path}`);
        throw new Error('Inactive episodic archive must never be accessed');
      }
      return Reflect.apply(actual[method], actual, args);
    }) as never;
  }
  return guarded;
});

const sessionsResponse = z.object({
  sessions: z.array(z.object({ instanceId: z.string() })),
});
const messagesResponse = z.object({ messages: z.array(z.unknown()) });
const titlesResponse = z.object({
  summaries: z.array(z.object({ episodeId: z.string(), title: z.string() })),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

const applications: Application[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of applications.splice(0).reverse()) await app.close();
  observed.forbiddenArchive = '';
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  observed.admin = undefined;
  observed.history = undefined;
  observed.archiveAccesses.length = 0;
  vi.unstubAllEnvs();
});

async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'klex-app-memory-acceptance-'));
  directories.push(result);
  await writeJsonStoreDocument(
    join(result, 'config.json'),
    CONFIG_STORE_DEFINITION,
    klexConfigSchema.parse({}),
    KLEX_VERSION,
  );
  return result;
}

async function boot(dataDirectory: string) {
  const logging = createLogger({ name: 'app-memory-acceptance' });
  const cli = {
    ...parseCliArgs([
      '--headless',
      '--data-dir',
      dataDirectory,
      '--no-cloud',
      '--no-analytics',
      '--disable-telemetry',
      '--no-auto-update',
    ]),
    dangerousLocalAdminApiPort: undefined,
    healthPort: undefined,
    cloudEnrollToken: undefined,
  };
  const app = createApplication({
    cli,
    logging,
    logStore: createLogStore(),
    disposeLogging: async () => undefined,
    closeInfrastructure: async () => undefined,
    attachTelemetryLogging: () => {
      throw new Error('Telemetry must stay offline');
    },
  });
  applications.push(app);
  expect(await app.start()).toBe(true);
  expect(observed.admin).toBeDefined();
  const admin = observed.admin;
  if (!admin) throw new Error('Admin API missing');
  const get = async <T>(path: string, schema: z.ZodType<T>) => {
    const response = await admin.handle(
      new Request(`http://acceptance.local${path}`),
    );
    expect(response.status, path).toBe(200);
    return schema.parse(await response.json());
  };
  return { app, get };
}

async function legacyDirectory() {
  const root = await directory();
  const database = createClient({
    url: `file:${join(root, 'sessions.sqlite')}`,
  });
  try {
    await database.execute('PRAGMA auto_vacuum = INCREMENTAL');
    await database.executeMultiple(
      await readFile(
        new URL(
          '../local-data-migration-fixtures/sessions-v2.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
  } finally {
    database.close();
  }
  const search = join(
    root,
    'extensions/io.stagewise/memory/episodic-search.sqlite',
  );
  await mkdir(dirname(search), { recursive: true });
  const cache = createClient({ url: `file:${search}` });
  try {
    await cache.executeMultiple(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('store', 'episodic-search-index'), ('schemaVersion', '1'), ('compatibilityVersion', '1'), ('minimumKlexVersion', '0.16.2'), ('writtenByKlexVersion', '0.28.0');
      CREATE TABLE episodic_files (relative_file TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL);
      CREATE TABLE episodic_vocabulary (term TEXT PRIMARY KEY, frequency INTEGER NOT NULL);
      CREATE TABLE episodic_term_trigrams (trigram TEXT NOT NULL, term TEXT NOT NULL REFERENCES episodic_vocabulary(term) ON DELETE CASCADE, PRIMARY KEY (trigram, term));
      CREATE INDEX episodic_term_trigrams_lookup ON episodic_term_trigrams(trigram);
      CREATE TABLE episodic_file_terms (relative_file TEXT NOT NULL, term TEXT NOT NULL, frequency INTEGER NOT NULL, PRIMARY KEY(relative_file, term));
      CREATE VIRTUAL TABLE episodic_entries USING fts5(text, normalized_text UNINDEXED, relative_file UNINDEXED, entry_ordinal UNINDEXED, occurred_at UNINDEXED, tokenize = 'porter unicode61');
      INSERT INTO episodic_files VALUES ('unreadable.jsonl', 100, 1);
      INSERT INTO episodic_entries VALUES ('legacy-only evidence', 'legacy-only evidence', 'unreadable.jsonl', 0, '2026-10-01T12:00:00Z');
    `);
  } finally {
    cache.close();
  }
  // Literal schema/metadata from v0.28.0; never derive an old fixture from the live definition.
  const summaryPath = join(
    root,
    'extensions/io.stagewise/episode-summary/summaries.sqlite',
  );
  await mkdir(dirname(summaryPath), { recursive: true });
  const summaries = createClient({ url: `file:${summaryPath}` });
  try {
    await summaries.executeMultiple(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('store', 'episode-summaries'), ('schemaVersion', '1'), ('compatibilityVersion', '1'), ('minimumKlexVersion', '0.16.2'), ('writtenByKlexVersion', '0.28.0');
      CREATE TABLE summaries (episode_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('titled', 'skipped')), title TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, created_at TEXT NOT NULL, model_id TEXT);
      CREATE INDEX summaries_listing ON summaries (status, started_at DESC, episode_id DESC);
      CREATE TABLE summary_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO summary_state VALUES ('cursor', 'legacy-newer'), ('cursor_initialized', 'true');
      INSERT INTO summaries VALUES ('legacy-older', 'titled', 'Preserved older title', '2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z', '2026-08-13T11:00:00Z', 'test/model'), ('legacy-newer', 'titled', 'Preserved newer title', '2026-08-14T10:00:00Z', '2026-08-14T11:00:00Z', '2026-08-14T11:00:00Z', 'test/model');
    `);
  } finally {
    summaries.close();
  }
  const archive = join(root, 'extensions/io.stagewise/memory/episodic');
  await mkdir(archive);
  await writeFile(
    join(archive, 'unreadable.jsonl'),
    'legacy file-only evidence',
  );
  observed.forbiddenArchive = archive;
  return root;
}

describe('composed application memory acceptance (offline)', () => {
  it('boots fresh, serves all retained API contracts, closes and restarts', async () => {
    const root = await directory();
    for (let restart = 0; restart < 2; restart++) {
      const { app, get } = await boot(root);
      if (restart === 0) {
        expect((await get('/v1/sessions', sessionsResponse)).sessions).toEqual(
          [],
        );
        const history = observed.history;
        if (!history) throw new Error('History missing');
        const recorder = history.openRecorder({
          instanceId: 'acceptance-source',
          sessionId: 'acceptance',
          kind: 'child',
          name: 'API evidence',
          createdAt: new Date().toISOString(),
        });
        recorder.scheduleSync(() => [
          {
            id: 'api-message',
            role: 'assistant',
            parts: [{ type: 'text', text: 'API evidence survives restart' }],
          },
        ]);
        await history.flush();
      }
      const sessions = await get('/v1/sessions', sessionsResponse);
      expect(sessions.sessions.length).toBeGreaterThan(0);
      const current = sessions.sessions.find(
        (session: { instanceId: string }) =>
          session.instanceId === 'acceptance-source',
      );
      expect(current).toBeDefined();
      if (!current) throw new Error('Persisted API evidence missing');
      expect(
        JSON.stringify(
          await get(
            `/v1/sessions/${current.instanceId}/messages`,
            messagesResponse,
          ),
        ),
      ).toContain('API evidence survives restart');
      expect(await get('/v1/episode-summaries', titlesResponse)).toEqual({
        summaries: [],
        nextCursor: null,
        hasMore: false,
      });
      await app.close();
    }
  }, 30_000);

  it('upgrades released history/cache, retains evidence and never accesses legacy archives across restarts', async () => {
    const root = await legacyDirectory();
    for (let restart = 0; restart < 2; restart++) {
      const { app, get } = await boot(root);
      const sessions = await get('/v1/sessions', sessionsResponse);
      expect(
        sessions.sessions.some(
          (session: { instanceId: string }) =>
            session.instanceId === 'instance-frozen',
        ),
      ).toBe(true);
      const messages = await get(
        '/v1/sessions/instance-frozen/messages',
        messagesResponse,
      );
      expect(messages.messages.length).toBeGreaterThan(0);
      const newest = await get('/v1/episode-summaries?limit=1', titlesResponse);
      expect(newest).toMatchObject({
        summaries: [
          { episodeId: 'legacy-newer', title: 'Preserved newer title' },
        ],
        nextCursor: 'legacy-newer',
        hasMore: true,
      });
      expect(
        await get(
          `/v1/episode-summaries?limit=1&cursor=${encodeURIComponent(newest.nextCursor ?? '')}`,
          titlesResponse,
        ),
      ).toMatchObject({
        summaries: [
          { episodeId: 'legacy-older', title: 'Preserved older title' },
        ],
        nextCursor: null,
        hasMore: false,
      });
      await app.close();
      expect(observed.archiveAccesses).toEqual([]);
    }
  }, 30_000);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UnsecuredJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  catalogByteLength,
  describeMachineCatalog,
  MACHINE_CATALOG_MAX_BYTES,
  type MachineCatalog,
} from '../src/cloud/catalog.js';
import { createMachineCatalogPublisher } from '../src/cloud/catalog-publisher.js';
import { createMachineMcp, type MachineMcp } from '../src/mcp.js';

const token = (claims: Record<string, unknown>) =>
  new UnsecuredJWT(claims).encode();
const catalog: MachineCatalog = {
  version: '1',
  daemonVersion: 'test',
  workloadReporting: false,
  capabilities: {},
  tools: [{ name: 'read', inputSchema: { type: 'object' } }],
  resources: [],
  resourceTemplates: [],
};

describe('machine catalog', () => {
  let cwd: string;
  let mcp: MachineMcp;
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'klex-machine-catalog-'));
    mcp = createMachineMcp(cwd);
  });
  afterAll(async () => {
    await mcp.close();
    await rm(cwd, { force: true, recursive: true });
  });

  it('describes the live tool surface within the size limit', async () => {
    const described = await describeMachineCatalog(mcp, {
      daemonVersion: '0.1.0',
      workloadReporting: false,
    });
    const names = described.tools.map((tool) => tool.name);
    expect(names).toContain('read');
    expect(names).toContain('createShellSession');
    expect(new Set(names).size).toBe(names.length);
    for (const tool of described.tools)
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    expect(described).toMatchObject({ version: '1', workloadReporting: false });
    expect(catalogByteLength(described)).toBeLessThanOrEqual(
      MACHINE_CATALOG_MAX_BYTES,
    );
  });

  it('rejects duplicate tool names', async () => {
    const source = {
      fetch: async (request: Request) => {
        const { method } = (await request.json()) as { method: string };
        const tool = { name: 'x', inputSchema: { type: 'object' } };
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          result:
            method === 'initialize'
              ? { capabilities: { tools: {} } }
              : { tools: [tool, tool] },
        });
      },
    };
    await expect(
      describeMachineCatalog(source, {
        daemonVersion: 't',
        workloadReporting: false,
      }),
    ).rejects.toThrow('duplicate');
  });
});

describe('catalog publisher', () => {
  it('reports the token generation and catalog', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    const publisher = createMachineCatalogPublisher({
      reportUrl: 'https://cloud.example/api/machines/m/lifecycle/report',
      getToken: async () => token({ machine_generation: 3 }),
      invalidateToken: () => {},
      buildCatalog: async () => catalog,
      fetch,
    });
    await expect(publisher.publish()).resolves.toBe('published');
    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ generation: 3, catalog });
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
  });

  it('skips legacy tokens without a generation claim', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const publisher = createMachineCatalogPublisher({
      reportUrl: 'https://cloud.example/r',
      getToken: async () => token({}),
      invalidateToken: () => {},
      buildCatalog: async () => catalog,
      fetch,
    });
    await expect(publisher.publish()).resolves.toBe('skipped-no-generation');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes the token after a stale generation and retries', async () => {
    let generation = 3;
    const invalidateToken = vi.fn(() => {
      generation = 4;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ code: 'stale_generation' }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const publisher = createMachineCatalogPublisher({
      reportUrl: 'https://cloud.example/r',
      getToken: async () => token({ machine_generation: generation }),
      invalidateToken,
      buildCatalog: async () => catalog,
      fetch,
      initialDelayMs: 1,
    });
    await expect(publisher.publish()).resolves.toBe('published');
    expect(invalidateToken).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      generation: 4,
    });
  });

  it('stops on permanent rejection and coalesces concurrent publishes', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 413 }));
    const buildCatalog = vi.fn(async () => catalog);
    const publisher = createMachineCatalogPublisher({
      reportUrl: 'https://cloud.example/r',
      getToken: async () => token({ machine_generation: 1 }),
      invalidateToken: () => {},
      buildCatalog,
      fetch,
    });
    const results = await Promise.all([
      publisher.publish(),
      publisher.publish(),
      publisher.publish(),
    ]);
    expect(results).toEqual(['rejected', 'rejected', 'rejected']);
    // One run plus one coalesced follow-up; the catalog is built once.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(buildCatalog).toHaveBeenCalledOnce();
  });

  it('close aborts pending retries', async () => {
    const publisher = createMachineCatalogPublisher({
      reportUrl: 'https://cloud.example/r',
      getToken: async () => token({ machine_generation: 1 }),
      invalidateToken: () => {},
      buildCatalog: async () => catalog,
      fetch: async () => new Response(null, { status: 503 }),
      initialDelayMs: 60_000,
    });
    const pending = publisher.publish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    publisher.close();
    await expect(pending).resolves.toBe('closed');
  });
});

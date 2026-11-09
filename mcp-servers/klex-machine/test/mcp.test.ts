import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { detectMachineDeviceType } from '../src/cloud/facts/device-type.js';
import { machineIcons } from '../src/icons.js';
import { createMachineMcp, type MachineMcp } from '../src/mcp.js';

vi.mock('../src/cloud/facts/device-type.js', () => ({
  detectMachineDeviceType: vi.fn(async () => 'laptop'),
}));

interface RpcResult {
  result: {
    content?: { type: string; text: string }[];
    isError?: boolean;
    tools?: { name: string }[];
    serverInfo?: { name: string; icons?: ReturnType<typeof machineIcons> };
  };
}

async function rpc(
  mcp: MachineMcp,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RpcResult['result']> {
  const response = await mcp.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  return (JSON.parse(data ?? text) as RpcResult).result;
}

async function callTool(
  mcp: MachineMcp,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const response = await rpc(mcp, 'tools/call', {
    name,
    arguments: arguments_,
  });
  expect(response.isError).not.toBe(true);
  return JSON.parse(response.content?.[0]?.text ?? 'null');
}

describe('machine MCP module', () => {
  let cwd: string;
  let mcp: MachineMcp;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'klex-machine-mcp-'));
    mcp = createMachineMcp(cwd);
  });

  afterAll(async () => {
    await mcp.close();
    await rm(cwd, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  });

  it('advertises detected device icons in the initialize response', async () => {
    const response = await rpc(mcp, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'icon-test', version: '1.0.0' },
    });
    expect(response.serverInfo?.name).toBe('klex-machine');
    expect(response.serverInfo?.icons).toEqual(machineIcons('laptop'));
  });

  it('omits device probes and uses generic icons when host details are disabled', async () => {
    const privateMcp = createMachineMcp(cwd, { omitHostDetails: true });
    const before = vi.mocked(detectMachineDeviceType).mock.calls.length;
    try {
      const response = await rpc(privateMcp, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'private-icon-test', version: '1.0.0' },
      });
      expect(response.serverInfo?.icons).toEqual(machineIcons());
      expect(vi.mocked(detectMachineDeviceType).mock.calls).toHaveLength(
        before,
      );
    } finally {
      await privateMcp.close();
    }
  });

  it('registers filesystem and shell tools', async () => {
    const response = await rpc(mcp, 'tools/list');
    const names = response.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain('read');
    expect(names).toContain('grepSearch');
    expect(names).toContain('createShellSession');
    expect(names).toContain('readShellSession');
  });

  it('serves filesystem operations through MCP', async () => {
    await callTool(mcp, 'write', {
      path: 'example.txt',
      content: 'machine data',
    });
    const read = (await callTool(mcp, 'read', {
      path: 'example.txt',
    })) as { content: string };
    expect(read.content).toBe('machine data');
  });

  it('retains shell sessions across MCP calls', async () => {
    const created = (await callTool(mcp, 'createShellSession', {})) as {
      id: string;
    };
    await callTool(mcp, 'writeShellSession', {
      id: created.id,
      data:
        process.platform === 'win32'
          ? 'echo persistent-session\\r'
          : "printf 'persistent-session\\n'\\r",
    });
    let cursor = 0;
    let output = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const read = (await callTool(mcp, 'readShellSession', {
        id: created.id,
        cursor,
        waitMs: 250,
      })) as { output: string; cursor: number };
      output += read.output;
      cursor = read.cursor;
      if (output.includes('persistent-session')) break;
    }
    expect(output).toContain('persistent-session');
    await callTool(mcp, 'closeShellSession', { id: created.id });
  });
});

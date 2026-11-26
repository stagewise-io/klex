import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contractDir,
  type JsonRpcError,
  type Machine,
  PUSH,
  startMachine,
  type ToolResult,
} from '../src/harness.js';

const readContract = <T>(name: string): T =>
  JSON.parse(readFileSync(join(contractDir, name), 'utf8')) as T;

const localTools = readContract<{ name: string }[]>('tools/local.json');
const pushTools = readContract<{ name: string }[]>('tools/push.json');
const server = readContract<{
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  instructions: string;
  pushInstructionsSuffix: string;
}>('server.json');
const validation =
  readContract<
    {
      name: string;
      push: boolean;
      arguments: Record<string, unknown>;
      result?: ToolResult;
      error?: JsonRpcError;
    }[]
  >('validation.json');

function instructions(machine: Machine): string {
  return server.instructions
    .replace('${cwd}', machine.cwd)
    .replace('${platform}', process.platform);
}

describe('MCP protocol', () => {
  it('serves the contract tool lists for plain and push-capable clients', async () => {
    const machine = await startMachine();
    const local = await machine.rpc<{ tools: unknown[] }>('tools/list');
    expect(local.result?.tools).toEqual(localTools);
    const push = await machine.rpc<{ tools: unknown[] }>(
      'tools/list',
      {},
      { push: true },
    );
    expect(push.result?.tools).toEqual(pushTools);
    expect(pushTools.map((tool) => tool.name)).toEqual([
      'createWatcher',
      'listWatchers',
      'cancelWatcher',
      ...localTools.map((tool) => tool.name),
    ]);
  });

  it('describes the server through server/discover', async () => {
    const machine = await startMachine();
    const { result } =
      await machine.rpc<Record<string, unknown>>('server/discover');
    expect(result).toMatchObject({
      capabilities: server.capabilities,
      instructions: instructions(machine),
    });
    expect(result?.supportedVersions).toContain('2026-07-28');
  });

  it('advertises generic icons and instructions on legacy initialize', async () => {
    const machine = await startMachine();
    const response = await fetch(machine.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy', version: '1.0.0' },
        },
      }),
    });
    const text = await response.text();
    const data =
      text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6) ?? text;
    const { result } = JSON.parse(data);
    expect(result.protocolVersion).toBe('2025-11-25');
    expect(result.serverInfo).toEqual(server.serverInfo);
    expect(result.instructions).toBe(instructions(machine));
  });

  it.each([false, true])(
    'works with the @modelcontextprotocol/client 2.4.0 SDK, push=%s',
    async (push) => {
      const machine = await startMachine();
      const client = new Client(
        { name: 'conformance', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      if (push) client.registerCapabilities({ extensions: { [PUSH]: {} } });
      const transport = new StreamableHTTPClientTransport(new URL(machine.url));
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual(
          (push ? pushTools : localTools).map((tool) => tool.name),
        );
        await machine.tool('write', { path: 'hello.txt', content: 'hi' });
        const read = await client.callTool({
          name: 'read',
          arguments: { path: 'hello.txt' },
        });
        expect(read.isError).not.toBe(true);
        expect(
          JSON.parse((read.content as { text: string }[])[0]?.text ?? ''),
        ).toMatchObject({ content: 'hi' });
      } finally {
        await client.close();
      }
    },
  );
});

describe('argument validation', () => {
  // Every case fails validation, so no tool runs and one machine serves all.
  let machine: Machine;
  beforeAll(async () => {
    machine = await startMachine({ manual: true });
  });
  afterAll(async () => {
    await machine?.dispose();
  });

  it.each(
    validation.map((entry) => [
      `${entry.name}${entry.push ? ' (push)' : ''} ${JSON.stringify(entry.arguments)}`,
      entry,
    ]),
  )('matches the contract for %s', async (_label, entry) => {
    const response = await machine.call(entry.name, entry.arguments, {
      push: entry.push,
    });
    if (entry.error) expect(response.error).toEqual(entry.error);
    else expect(response.result).toEqual(entry.result);
  });
});

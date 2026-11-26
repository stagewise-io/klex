#!/usr/bin/env node
// Regenerates the golden files in this directory from the built TypeScript
// server: `pnpm --filter @klex/machine build && node contract/dump.mjs`.
// The conformance suite fails when either implementation drifts from them.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const contractDir = import.meta.dirname;
const entry = resolve(contractDir, '../dist/index.js');
const PUSH = 'io.stagewise/push-notifications';
const PROTOCOL = '2026-07-28';

const dataDir = await mkdtemp(join(tmpdir(), 'klex-machine-contract-'));
const child = spawn(
  process.execPath,
  [
    entry,
    'serve',
    '--mode',
    'local',
    '--port',
    '0',
    '--omit-host-details',
    '--data-dir',
    dataDir,
    '--cwd',
    dataDir,
  ],
  {
    env: { ...process.env, KLEX_MACHINE_DESKTOP: 'off', NO_COLOR: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);

try {
  const port = await new Promise((resolvePort, reject) => {
    const lines = createInterface({ input: child.stderr });
    lines.on('line', (line) => {
      try {
        const record = JSON.parse(line);
        if (record.message === 'klex-machine MCP server listening')
          resolvePort(record.port);
      } catch {}
    });
    child.once('exit', (code) => reject(new Error(`server exited: ${code}`)));
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  let nextId = 1;
  const call = async (method, params, capabilities) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': PROTOCOL,
        ...(params.name === undefined ? {} : { 'mcp-name': params.name }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL,
            'io.modelcontextprotocol/clientInfo': {
              name: 'contract-dump',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': capabilities,
          },
        },
      }),
    });
    const body = await response.json();
    if (body.error) {
      const error = new Error(`${method}: ${JSON.stringify(body.error)}`);
      error.rpc = body.error;
      throw error;
    }
    return body.result;
  };

  const local = await call('tools/list', {}, {});
  const push = await call('tools/list', {}, { extensions: { [PUSH]: {} } });
  const discover = await call('server/discover', {}, {});
  const instructions = discover.instructions.replace(
    `Relative paths resolve from ${dataDir}.`,
    'Relative paths resolve from ${cwd}.',
  );
  const write = (name, value) =>
    writeFile(join(contractDir, name), `${JSON.stringify(value, null, 2)}\n`);
  await write('tools/local.json', local.tools);
  await write('tools/push.json', push.tools);
  await write('server.json', {
    serverInfo: discover.serverInfo,
    capabilities: discover.capabilities,
    instructions: instructions.replace(
      `Operating system: ${process.platform}.`,
      'Operating system: ${platform}.',
    ),
    pushInstructionsSuffix:
      ' Watcher outcomes and requested shell-exit notifications arrive as push notifications.',
  });

  // Every case must fail validation: valid arguments would run the tool.
  const uuid = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
  const cases = [
    ['read', {}],
    ['read', { path: '' }],
    ['read', { path: 1 }],
    ['read', { path: null }],
    ['read', { path: [] }],
    ['read', { path: {} }],
    ['read', { path: true }],
    ['read', { path: 'a', encoding: 'hex' }],
    ['read', { path: 'a', startLine: 0 }],
    ['read', { path: 'a', startLine: 1.5 }],
    ['read', { path: 'a', startLine: '1' }],
    ['read', { path: 'a', startLine: -1, endLine: 0 }],
    ['read', { path: '', extra: 1 }],
    ['list', { path: 2 }],
    ['write', { path: 'a' }],
    ['write', { path: 'a', content: 1, encoding: 'utf8' }],
    ['multiEdit', { path: 'a', edits: [] }],
    ['multiEdit', { path: 'a', edits: [{}] }],
    [
      'multiEdit',
      { path: 'a', edits: [{ oldString: 'x', newString: 1, replaceAll: 'y' }] },
    ],
    ['multiEdit', { path: 'a', edits: 'x' }],
    ['multiEdit', { path: 'a', edits: [null] }],
    ['mkdir', {}],
    ['delete', { path: '' }],
    ['copy', { source: 'a' }],
    ['copy', { source: 'a', destination: 'b', move: 1, overwrite: 'no' }],
    ['glob', { patterns: [] }],
    ['glob', { patterns: [''] }],
    ['glob', { patterns: ['a'], limit: 0 }],
    ['glob', { patterns: ['a'], exclude: [1] }],
    ['glob', { patterns: 'a' }],
    ['glob', { patterns: ['a'], hidden: 'yes', gitignore: 0 }],
    ['grepSearch', { pattern: 'a', context: 21 }],
    ['grepSearch', { pattern: 'a', context: -1 }],
    ['grepSearch', { pattern: 'a', context: 1.5 }],
    ['grepSearch', { pattern: '', include: 'x', caseSensitive: 1 }],
    ['createShellSession', { cols: 0 }],
    ['createShellSession', { env: { A: 1 } }],
    ['createShellSession', { env: [] }],
    ['createShellSession', { args: 'x' }],
    ['createShellSession', { args: [1] }],
    ['createShellSession', { cols: 9007199254740992 }],
    ['createShellSession', { rows: 1e300 }],
    ['createShellSession', { cwd: '', shell: '' }],
    ['writeShellSession', {}],
    ['writeShellSession', { id: 'x', data: 1 }],
    ['writeShellSession', { id: uuid.toUpperCase() }],
    ['writeShellSession', { id: '00000000-0000-0000-0000-000000000000' }],
    ['readShellSession', { id: 'x' }],
    ['readShellSession', { id: uuid, cursor: -1, waitMs: 30001 }],
    ['readShellSession', { id: uuid, cursor: 0.5 }],
    ['resizeShellSession', { id: uuid }],
    ['resizeShellSession', { id: uuid, cols: -1, rows: 'x' }],
    ['closeShellSession', { id: 7 }],
    ['createWatcher', {}, true],
    [
      'createWatcher',
      { command: '', title: 'x'.repeat(201), timeoutMs: 999 },
      true,
    ],
    [
      'createWatcher',
      { command: 'x'.repeat(16385), title: 't', timeoutMs: 604800001 },
      true,
    ],
    [
      'createWatcher',
      { command: 'x', title: 't', timeoutMs: 1000.5, env: { A: null } },
      true,
    ],
    [
      'createWatcher',
      { command: 'x', title: 't', timeoutMs: 1000, cwd: '' },
      true,
    ],
    ['cancelWatcher', { id: 'nope' }, true],
    ['createWatcher', { command: 'x', title: 't', timeoutMs: 1000 }],
    ['nope', {}],
  ];
  const validation = [];
  for (const [name, args, withPush = false] of cases) {
    const capabilities = withPush ? { extensions: { [PUSH]: {} } } : {};
    try {
      const result = await call(
        'tools/call',
        { name, arguments: args },
        capabilities,
      );
      if (!result.isError)
        throw new Error(`${name} accepted ${JSON.stringify(args)}`);
      validation.push({ name, push: withPush, arguments: args, result });
    } catch (error) {
      if (!error.rpc) throw error;
      validation.push({
        name,
        push: withPush,
        arguments: args,
        error: error.rpc,
      });
    }
  }
  await write('validation.json', validation);
} finally {
  child.kill('SIGTERM');
  await new Promise((done) => child.once('exit', done));
  await rm(dataDir, { force: true, recursive: true });
}

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
const PUSH_CAPABILITIES = { extensions: { [PUSH]: {} } };

async function startServer(desktop) {
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
      env: { ...process.env, KLEX_MACHINE_DESKTOP: desktop, NO_COLOR: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const close = async () => {
    child.kill('SIGTERM');
    await new Promise((done) => child.once('exit', done));
    await rm(dataDir, { force: true, recursive: true });
  };
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
    const instructions = async (capabilities) =>
      (await call('server/discover', {}, capabilities)).instructions
        .replace(
          `Relative paths resolve from ${dataDir}.`,
          'Relative paths resolve from ${cwd}.',
        )
        .replace(
          `Operating system: ${process.platform}.`,
          'Operating system: ${platform}.',
        );
    return { call, close, instructions };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Every case must fail validation: valid arguments would run the tool. */
async function validate(server, cases) {
  const validation = [];
  for (const [name, args, withPush = false] of cases) {
    const capabilities = withPush ? PUSH_CAPABILITIES : {};
    try {
      const result = await server.call(
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
  return validation;
}

const write = (name, value) =>
  writeFile(join(contractDir, name), `${JSON.stringify(value, null, 2)}\n`);

const uuid = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
const baseCases = [
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

const point = { x: 0, y: 0 };
const commonDesktopCases = [
  ['desktop_screenshot', { format: 'gif' }],
  ['desktop_zoom', { ...point, width: 0, height: 1 }],
  ['desktop_zoom', { x: -1, y: 0, width: 1, height: 1, format: 'bmp' }],
  ['desktop_zoom', { x: 0.5, y: 0, width: 1 }],
  ['desktop_click', { ...point, count: 4 }],
  ['desktop_click', { ...point, button: 'back', screenshot: 'yes' }],
  ['desktop_click', { ...point, modifiers: ['a', 'b', 'c', 'd', 'e'] }],
  ['desktop_click', { ...point, modifiers: [''], settleMs: 5001 }],
  ['desktop_click', { ...point, modifiers: ['x'.repeat(17)], settleMs: -1 }],
  ['desktop_drag', { from: { x: 0 }, to: point }],
  ['desktop_drag', { from: point, button: 'side' }],
  ['desktop_move', { x: 0, y: -1 }],
  ['desktop_move', { x: '1', y: 1.5 }],
  ['desktop_scroll', { ...point, direction: 'in' }],
  ['desktop_scroll', { ...point, direction: 'up', amount: 51 }],
  ['desktop_scroll', { ...point, direction: 'up', amount: 0 }],
  ['desktop_type', { text: '' }],
  ['desktop_type', { text: 'x'.repeat(10001) }],
  ['desktop_key', { keys: [] }],
  ['desktop_key', { keys: [''] }],
  ['desktop_key', { keys: Array.from({ length: 33 }, () => 'a') }],
  ['desktop_key', { keys: ['x'.repeat(65)] }],
  ['desktop_key', { keys: 'enter' }],
  ['desktop_focus_window', {}],
  ['desktop_focus_window', { id: 'w1' }],
  ['desktop_launch', { command: '' }],
  ['desktop_launch', { command: 'x', args: [1] }],
  ['desktop_launch', { command: 'x', cwd: '' }],
  ['desktop_launch', { command: 'x'.repeat(4097) }],
  [
    'desktop_launch',
    { command: 'x', args: Array.from({ length: 65 }, () => 'a') },
  ],
  ['desktop_launch', { command: 'x', args: ['x'.repeat(16385)] }],
];
const basicDesktopCases = [
  ['desktop_click', { x: 1.5, y: 0 }],
  ['desktop_click', { x: 0 }],
  ['desktop_click', { ref: 'r1' }],
  ['desktop_accessibility_tree', {}],
];
const accessibilityDesktopCases = [
  ['desktop_click', {}],
  ['desktop_click', { x: 0 }],
  ['desktop_click', { ...point, ref: 'r1' }],
  ['desktop_click', { y: 0, ref: 'r1' }],
  ['desktop_click', { ref: 'x1' }],
  ['desktop_click', { ref: 'r1', x: -1 }],
  ['desktop_accessibility_tree', { window: 'abc' }],
  ['desktop_accessibility_tree', { maxDepth: 61, maxNodes: 0 }],
  ['desktop_accessibility_tree', { interactiveOnly: 1, ref: 'r' }],
  ['desktop_accessibility_tree', { maxDepth: 1.5 }],
];

const base = await startServer('off');
try {
  const local = await base.call('tools/list', {}, {});
  const push = await base.call('tools/list', {}, PUSH_CAPABILITIES);
  const discover = await base.call('server/discover', {}, {});
  await write('tools/local.json', local.tools);
  await write('tools/push.json', push.tools);
  await write('server.json', {
    serverInfo: discover.serverInfo,
    capabilities: discover.capabilities,
    instructions: await base.instructions({}),
    pushInstructionsSuffix:
      ' Watcher outcomes and requested shell-exit notifications arrive as push notifications.',
  });
  await write('validation.json', await validate(base, baseCases));

  const baseInstructions = await base.instructions({});
  const suffix = (instructions) => {
    if (!instructions.startsWith(baseInstructions))
      throw new Error(`Unexpected instructions: ${instructions}`);
    return instructions.slice(baseInstructions.length);
  };
  /** Desktop tools come first; everything after them is the base list. */
  const desktopTools = async (server) => {
    const tools = (await server.call('tools/list', {}, {})).tools;
    const count = tools.findIndex((tool) => !tool.name.startsWith('desktop_'));
    if (JSON.stringify(tools.slice(count)) !== JSON.stringify(local.tools))
      throw new Error('Desktop tools are not a prefix of the base tools');
    const withPush = (await server.call('tools/list', {}, PUSH_CAPABILITIES))
      .tools;
    if (
      JSON.stringify(withPush) !==
      JSON.stringify([...tools.slice(0, count), ...push.tools])
    )
      throw new Error('Desktop tools differ with push notifications');
    return tools.slice(0, count);
  };

  const fake = await startServer('fake');
  const basic = await startServer('fake-basic');
  const unavailable = await startServer('fake-unavailable');
  try {
    const discovered = await fake.call('server/discover', {}, {});
    const accessibilityInstructions = suffix(await fake.instructions({}));
    const available = suffix(await basic.instructions({}));
    const unavailableHint = suffix(await unavailable.instructions({}));
    if (
      !accessibilityInstructions.startsWith(available) ||
      (await fake.instructions(PUSH_CAPABILITIES)) !==
        `${baseInstructions}${accessibilityInstructions} Watcher outcomes and requested shell-exit notifications arrive as push notifications.`
    )
      throw new Error('Unexpected desktop instructions');
    const hint = 'The fake desktop is unavailable.';
    if (!unavailableHint.endsWith(hint))
      throw new Error(`Unexpected hint instructions: ${unavailableHint}`);
    if (
      JSON.stringify((await unavailable.call('tools/list', {}, {})).tools) !==
      JSON.stringify(local.tools)
    )
      throw new Error('An unavailable desktop still lists tools');
    await write('desktop.json', {
      capabilities: discovered.capabilities,
      instructions: {
        available,
        accessibility: accessibilityInstructions.slice(available.length),
        unavailable: `${unavailableHint.slice(0, -hint.length)}\${hint}`,
      },
      resources: (await fake.call('resources/list', {}, {})).resources,
      tools: await desktopTools(basic),
      accessibilityTools: await desktopTools(fake),
    });
    await write('desktop-validation.json', [
      ...(
        await validate(basic, [...commonDesktopCases, ...basicDesktopCases])
      ).map((item) => ({ desktop: 'fake-basic', ...item })),
      ...(
        await validate(fake, [
          ...commonDesktopCases,
          ...accessibilityDesktopCases,
        ])
      ).map((item) => ({ desktop: 'fake', ...item })),
    ]);
  } finally {
    await Promise.all([fake.close(), basic.close(), unavailable.close()]);
  }
} finally {
  await base.close();
}

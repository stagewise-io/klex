#!/usr/bin/env node
// Exercise the packaged executable, not a mocked health-server module.
// A FIFO holds directory-lock acquisition during startup. A local model
// response holds a real god-session turn during termination. No sleeps
// decide either state; the test releases each gate after checking probes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const image = process.argv[2];
if (!image) throw new Error('Usage: node smoke-health.mjs <image>');
const name = `klex-health-${process.pid}-${Date.now()}`;
const volume = `${name}-data`;
const client = `${name}-client`;
const nodeImage = 'node:26.8.1-bookworm';
const modelId = 'smoke-model';
const timeoutMs = 60_000;
let heldResponse;
let modelReleased = false;

async function docker(...args) {
  return (
    await exec('docker', args, { timeout: timeoutMs, maxBuffer: 4_000_000 })
  ).stdout.trim();
}
async function waitFor(label, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function complete(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const choice of [
    {
      delta: { role: 'assistant', content: 'Smoke turn complete.' },
      finish_reason: null,
    },
    { delta: {}, finish_reason: 'stop' },
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: modelId, choices: [{ index: 0, ...choice }] })}\n\n`,
    );
  }
  response.end('data: [DONE]\n\n');
}
const model = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: modelId, object: 'model', created: 1, owned_by: 'smoke' }],
      }),
    );
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    for await (const _chunk of request) {
      /* consume the request before holding its response */
    }
    if (modelReleased) complete(response);
    else heldResponse = response;
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => model.listen(0, '0.0.0.0', resolve));
const address = model.address();
assert(address && typeof address !== 'string');
const config = {
  configVersion: 2,
  providers: {
    smoke: {
      type: 'chat-completions',
      settings: {
        baseUrl: `http://host.docker.internal:${address.port}/v1`,
        apiKey: 'smoke-only',
      },
      knownModels: { [modelId]: { contextSize: 128_000 } },
    },
  },
  modelSelection: { chat: [{ providerId: 'smoke', modelId }] },
};

try {
  await docker('volume', 'create', volume);
  await docker(
    'run',
    '--rm',
    '-v',
    `${volume}:/data`,
    '--entrypoint',
    'sh',
    image,
    '-c',
    'mkdir -p /data/agent; printf "%s" "$1" > /data/agent/config.json; mkfifo /data/agent/.klex.lock',
    'fixture',
    JSON.stringify(config),
  );
  await docker(
    'run',
    '-d',
    '--name',
    name,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--add-host',
    'host.docker.internal:host-gateway',
    '-e',
    'KLEX_NO_CLOUD=1',
    '-e',
    'KLEX_NO_ANALYTICS=1',
    '-e',
    'KLEX_HEALTH_PORT=8080',
    '-e',
    'KLEX_DRAIN_TIMEOUT_MS=30000',
    '-p',
    '127.0.0.1::8080',
    '-v',
    `${volume}:/data`,
    image,
    '--dangerous-local-admin-api-port',
    '31337',
  );
  const base = `http://${await docker('port', name, '8080/tcp')}`;
  async function status(path) {
    return (
      await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2_000) })
    ).status;
  }
  await waitFor('live listener during startup', async () => {
    try {
      return (await status('/livez')) === 200;
    } catch {
      return false;
    }
  });
  assert.equal(await status('/readyz'), 503);
  assert.equal(await status('/livez'), 200);
  console.log(
    'ok: packaged executable is live but not ready during gated startup',
  );
  await docker(
    'exec',
    name,
    'sh',
    '-c',
    'printf "{\\"pid\\":999999}" > /data/agent/.klex.lock',
  );
  await waitFor(
    'runtime readiness',
    async () => (await status('/readyz')) === 200,
  );

  // The admin listener stays on loopback inside the agent's network namespace.
  // A one-shot Node client shares that namespace; no admin port is published.
  await docker(
    'run',
    '--rm',
    '--name',
    client,
    '--network',
    `container:${name}`,
    nodeImage,
    'node',
    '--input-type=module',
    '-e',
    `const response = await fetch('http://127.0.0.1:31337/v1/god-messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: [{ type: 'text', text: 'Reply with a short acknowledgement.' }] }) }); if (response.status !== 202) throw new Error(await response.text());`,
  );
  await waitFor('active model request', () => Boolean(heldResponse));
  assert.equal(await status('/readyz'), 200);
  await docker('kill', '--signal', 'TERM', name);
  await waitFor(
    'drain readiness transition',
    async () => (await status('/readyz')) === 503,
  );
  assert.equal(await status('/livez'), 200);
  assert.equal(
    await docker('inspect', '-f', '{{.State.Running}}', name),
    'true',
  );
  console.log(
    'ok: active turn remains live but not ready during SIGTERM drain',
  );
  modelReleased = true;
  assert(heldResponse);
  complete(heldResponse);
  assert.equal(await docker('wait', name), '0');
  const logs = await docker('logs', name);
  assert(logs.includes('Agent drain finished'));
  assert(!logs.includes('Klex Bot startup failed'));
  console.log('ok: released turn finishes, termination drain exits 0');
} catch (error) {
  console.error(await docker('logs', name).catch(() => 'No container logs'));
  throw error;
} finally {
  await docker('rm', '-f', client, name).catch(() => undefined);
  await docker('volume', 'rm', '-f', volume).catch(() => undefined);
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
}

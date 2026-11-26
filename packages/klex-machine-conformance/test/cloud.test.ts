import { readFile, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type FakeCloud, startFakeCloud } from '../src/cloud.js';
import {
  type CliOptions,
  implementation,
  PROTOCOL,
  runCli,
  spawnCli,
  temporaryDirectory,
  waitFor,
  windows,
} from '../src/harness.js';

let cloud: FakeCloud;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  cloud = await startFakeCloud(await temporaryDirectory());
  env = { NODE_EXTRA_CA_CERTS: cloud.caFile };
});
afterEach(async () => {
  await cloud.close();
});

const normalize = (text: string) =>
  text.replace(/klex-machine(?:-rs)?/g, 'klex-machine');
const errorLine = (stderr: string) =>
  normalize(stderr.trim()).replace(/^klex-machine: /, '');
const live = (machineId: string) =>
  `Machine ${machineId} is live. You can now assign it to Klex Bots.\nKeep this process running; press Ctrl+C to stop.\n`;

function enroll(code: string, dataDir: string, options: CliOptions = {}) {
  return runCli(
    [
      'cloud',
      'enroll',
      code,
      '--no-serve',
      '--cloud-base-url',
      cloud.baseUrl,
      '--data-dir',
      dataDir,
    ],
    { ...options, env: { ...env, ...options.env } },
  );
}

async function mcp(
  machineId: string,
  method: string,
  params: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  return fetch(cloud.mcpUrl(machineId), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': PROTOCOL,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL,
          'io.modelcontextprotocol/clientInfo': {
            name: 'klex-machine-conformance',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

async function toolNames(machineId: string, principal: string) {
  const response = await mcp(
    machineId,
    'tools/list',
    {},
    await cloud.accessToken(principal, machineId),
  );
  if (response.status !== 200) return undefined;
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  return body.result.tools.map((tool) => tool.name);
}

describe('cloud enrollment', () => {
  it('enrolls once per code and keeps the identity', async () => {
    const dataDir = await temporaryDirectory();
    const code = cloud.issueCode();
    const first = await enroll(code, dataDir);
    expect(first).toMatchObject({ code: 0, stderr: '' });
    expect(normalize(first.stdout)).toBe(
      'Enrolled machine machine-1\nStart it with: klex-machine\n',
    );

    const enrollment = JSON.parse(
      await readFile(join(dataDir, 'identity', 'enrollment.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(enrollment)).toEqual([
      'version',
      'keyId',
      'machineId',
      'clientId',
      'cloudBaseUrl',
      'enrolledAt',
      'tokenEndpoint',
      'proxyConnectionResource',
      'proxyConnectionUrl',
      'mcpResourceUrl',
      'oauthProtectedResourceUrl',
      'enrollmentCodeSha256',
    ]);
    expect(enrollment).toMatchObject({
      version: 1,
      machineId: 'machine-1',
      cloudBaseUrl: cloud.baseUrl,
      mcpResourceUrl: cloud.mcpResource('machine-1'),
    });
    expect(new Date(enrollment.enrolledAt as string).toISOString()).toBe(
      enrollment.enrolledAt,
    );
    const [request] = cloud.enrollRequests as {
      enrollmentCode: string;
      jwks: { keys: Record<string, string>[] };
    }[];
    expect(request!.enrollmentCode).toBe(code);
    const jwk = request!.jwks.keys[0]!;
    expect(Object.keys(jwk)).toEqual(['kty', 'crv', 'x', 'kid', 'alg', 'use']);
    expect(jwk).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
      kid: enrollment.keyId,
    });
    const pem = await readFile(
      join(dataDir, 'identity', 'private-key.pem'),
      'utf8',
    );
    expect(pem).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=]{64}\n-----END PRIVATE KEY-----\n$/,
    );
    if (!windows) {
      expect(
        (await stat(join(dataDir, 'identity', 'private-key.pem'))).mode & 0o777,
      ).toBe(0o600);
      expect(
        (await stat(join(dataDir, 'identity', 'enrollment.json'))).mode & 0o777,
      ).toBe(0o600);
    }

    const again = await enroll(` ${code} `, dataDir);
    expect(again).toMatchObject({ code: 0, stderr: '' });
    expect(normalize(again.stdout)).toBe(
      'Already enrolled as machine machine-1; enrollment code not used again.\nStart it with: klex-machine\n',
    );
    expect(cloud.enrollRequests).toHaveLength(1);

    const conflict = await enroll(cloud.issueCode(), dataDir);
    expect(conflict).toMatchObject({ code: 1, stdout: '' });
    expect(errorLine(conflict.stderr)).toBe(
      'This machine is already enrolled in Cloud. Delete it there, then run the command with a new code.',
    );

    const invalid = await enroll('unknown-code', dataDir);
    expect(invalid).toMatchObject({ code: 1, stdout: '' });
    expect(errorLine(invalid.stderr)).toBe(
      'Enrollment code is invalid, expired, or already used. Generate a new code in Cloud. Existing enrollment for machine machine-1 is unchanged; start it with: klex-machine',
    );

    const empty = await enroll('   ', dataDir);
    expect(errorLine(empty.stderr)).toBe('Enrollment code is required');

    cloud.machines.get('machine-1')!.deleted = true;
    const replaced = await enroll(cloud.issueCode(), dataDir);
    expect(replaced).toMatchObject({ code: 0, stderr: '' });
    expect(normalize(replaced.stdout)).toBe(
      'Enrolled machine machine-2\nStart it with: klex-machine\n',
    );
    const updated = JSON.parse(
      await readFile(join(dataDir, 'identity', 'enrollment.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(updated.keyId).toBe(enrollment.keyId);
  });

  it('reports enrollment failures', async () => {
    const dataDir = await temporaryDirectory();
    cloud.override('enroll', (response) => {
      response.writeHead(500).end();
    });
    const failed = await enroll(cloud.issueCode(), dataDir);
    expect(errorLine(failed.stderr)).toBe(
      'Machine enrollment failed with HTTP 500',
    );

    cloud.override('enroll', (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ machineId: 'm', clientId: 'c' }));
    });
    const incomplete = await enroll(cloud.issueCode(), dataDir);
    expect(errorLine(incomplete.stderr)).toBe(
      'Enrollment response has invalid tokenEndpoint',
    );

    cloud.override('enroll', undefined);
    const untrusted = await enroll(cloud.issueCode(), dataDir, {
      env: { NODE_EXTRA_CA_CERTS: '' },
    });
    expect(errorLine(untrusted.stderr)).toBe('fetch failed');
  });

  // Needs both binaries; the TypeScript-only CI jobs do not build Rust.
  it.runIf(implementation === 'rust')(
    'shares enrollment state between implementations',
    async () => {
      const directions = [
        ['ts', 'rust'],
        ['rust', 'ts'],
      ] as const;
      for (const [index, [enroller, server]] of directions.entries()) {
        const dataDir = await temporaryDirectory();
        const enrolled = await enroll(cloud.issueCode(), dataDir, {
          implementation: enroller,
        });
        expect(enrolled).toMatchObject({ code: 0, stderr: '' });
        const machine = spawnCli(
          ['serve', '--mode', 'enrolled', '--data-dir', dataDir],
          { env, implementation: server },
        );
        await machine.stdoutContains('is live');
        expect(normalize(machine.output.stdout)).toBe(
          live(`machine-${index + 1}`),
        );
        expect(cloud.tokenRequests).toHaveLength(index + 1);
        await machine.stop();
      }
    },
  );
});

describe('cloud serving', () => {
  it('connects through the proxy and authenticates principals', async () => {
    const dataDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const machine = spawnCli(
      [
        'cloud',
        'enroll',
        cloud.issueCode(),
        '--cloud-base-url',
        cloud.baseUrl,
        '--data-dir',
        dataDir,
        '--cwd',
        cwd,
      ],
      { env },
    );
    await machine.stdoutContains('is live');
    expect(normalize(machine.output.stdout)).toBe(
      `Enrolled machine machine-1\nConnecting to Klex Cloud...\n${live('machine-1')}`,
    );

    const enrollment = JSON.parse(
      await readFile(join(dataDir, 'identity', 'enrollment.json'), 'utf8'),
    ) as Record<string, string>;
    const [token] = cloud.tokenRequests;
    expect(token!.formKeys).toEqual([
      'grant_type',
      'scope',
      'resource',
      'client_id',
      'client_assertion_type',
      'client_assertion',
    ]);
    expect(token!.contentType).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
    expect(token!.form.client_assertion_type).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    expect(token!.header).toEqual({ alg: 'EdDSA', kid: enrollment.keyId });
    expect(Object.keys(token!.claims)).toEqual([
      'jti',
      'aud',
      'exp',
      'iat',
      'nbf',
      'iss',
      'sub',
    ]);
    const claims = token!.claims as Record<string, number | string>;
    expect(claims.exp as number).toBe((claims.iat as number) + 60);
    expect(claims.nbf).toBe(claims.iat);
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [connection] = cloud.connections;
    const facts = connection!.facts as {
      v: number;
      machineVersion: string;
      os: Record<string, unknown>;
      cpu: Record<string, unknown>;
      memory: Record<string, unknown>;
      host: Record<string, unknown>;
    };
    expect(facts).toMatchObject({
      v: 1,
      os: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
      },
      cpu: { logicalCores: os.availableParallelism() },
      memory: { totalBytes: os.totalmem() },
      host: { hostname: os.hostname(), workspacePath: cwd },
    });
    expect(facts.machineVersion).toMatch(/^\d+\.\d+\.\d+/);
    if (process.platform === 'darwin') expect(facts.os.name).toBe('macOS');
    if (process.platform === 'win32') expect(facts.os.name).toBe('Windows');
    if (process.platform !== 'linux' || process.arch === 'x64')
      expect(facts.cpu.model).toBe(
        os
          .cpus()
          .find((cpu) => cpu.model.trim())
          ?.model.trim(),
      );
    expect(facts.host.workspaceVolumeTotalBytes).toBeGreaterThan(0);

    expect(await toolNames('machine-1', 'agent-a')).toContain(
      'createShellSession',
    );
    expect(await toolNames('machine-1', 'agent-b')).toContain(
      'createShellSession',
    );

    const challenge = `Bearer resource_metadata="${enrollment.oauthProtectedResourceUrl}", scope="mcp:use"`;
    for (const credential of [
      undefined,
      'not-a-jwt',
      await cloud.accessToken('agent-a', 'machine-1', { scope: 'openid' }),
      await cloud.accessToken('agent-a', 'machine-2'),
      await cloud.accessToken('agent-a', 'machine-1', { client_id: '' }),
    ]) {
      const response = await mcp('machine-1', 'tools/list', {}, credential);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(challenge);
      expect(await response.text()).toBe('Unauthorized');
    }

    const stopped = await machine.stop('SIGTERM');
    if (!windows) expect(stopped).toEqual({ code: 0, signal: null });
  });

  it('reconnects with a fresh token', async () => {
    const dataDir = await temporaryDirectory();
    expect((await enroll(cloud.issueCode(), dataDir)).code).toBe(0);
    const machine = spawnCli(
      [
        'serve',
        '--mode',
        'enrolled',
        '--omit-host-details',
        '--data-dir',
        dataDir,
      ],
      { env },
    );
    await machine.stdoutContains('is live');
    expect(cloud.connections[0]!.facts).not.toHaveProperty('host');
    cloud.dropConnections();
    await waitFor(() => (cloud.connections.length >= 2 ? true : undefined), {
      timeout: 15_000,
    });
    expect(cloud.tokenRequests.length).toBeGreaterThanOrEqual(2);
    expect(
      await waitFor(() => toolNames('machine-1', 'agent-a'), {
        timeout: 15_000,
      }),
    ).toContain('createShellSession');
  });

  it('rejects mismatched protected resource metadata and token errors', async () => {
    const dataDir = await temporaryDirectory();
    const serve = () =>
      runCli(['serve', '--mode', 'enrolled', '--data-dir', dataDir], { env });

    const missing = await serve();
    expect(missing.code).toBe(1);
    expect(errorLine(missing.stderr)).toBe(
      `Machine is not enrolled: ${join(dataDir, 'identity', 'enrollment.json')}`,
    );

    expect((await enroll(cloud.issueCode(), dataDir)).code).toBe(0);
    cloud.override('prm', (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          resource: 'https://elsewhere.example/mcp',
          authorization_servers: [`${cloud.baseUrl}/api/auth`],
        }),
      );
    });
    expect(errorLine((await serve()).stderr)).toBe(
      'Protected resource metadata does not match enrollment',
    );
    cloud.override('prm', (response) => {
      response.writeHead(503).end();
    });
    expect(errorLine((await serve()).stderr)).toBe(
      'Protected resource metadata request failed (503)',
    );
    cloud.override('prm', undefined);

    cloud.override('token', (response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_client' }));
    });
    expect(errorLine((await serve()).stderr)).toBe(
      'server responded with an error in the response body',
    );
    cloud.override('token', (response) => {
      response.writeHead(500).end('nope');
    });
    expect(errorLine((await serve()).stderr)).toBe(
      '"response" is not a conform Token Endpoint response (unexpected HTTP status code)',
    );
  });
});

describe('managed bootstrap', () => {
  it('consumes the code file once and then reuses the enrollment', async () => {
    const dataDir = await temporaryDirectory();
    const codeFile = join(await temporaryDirectory(), 'code');
    await writeFile(codeFile, `${cloud.issueCode()}\n`);
    const args = [
      'cloud',
      'bootstrap',
      '--enrollment-code-file',
      codeFile,
      '--cloud-base-url',
      cloud.baseUrl,
      '--data-dir',
      dataDir,
    ];
    const first = spawnCli(args, { env });
    await waitFor(() => (cloud.connections.length === 1 ? true : undefined), {
      timeout: 20_000,
    });
    await expect(stat(codeFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await first.stop('SIGKILL');
    expect(first.output.stdout).toBe('');

    await writeFile(codeFile, 'stale-code\n');
    const second = spawnCli(args, { env });
    await waitFor(() => (cloud.connections.length === 2 ? true : undefined), {
      timeout: 20_000,
    });
    await expect(stat(codeFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(cloud.enrollRequests).toHaveLength(1);
    await second.stop('SIGKILL');

    const elsewhere = await runCli(
      [
        'cloud',
        'bootstrap',
        '--enrollment-code-file',
        '-',
        '--cloud-base-url',
        'https://127.0.0.1:9',
        '--data-dir',
        dataDir,
      ],
      { env },
    );
    expect(elsewhere.code).toBe(1);
    expect(errorLine(elsewhere.stderr)).toBe(
      'Managed machine enrollment belongs to a different cloud deployment',
    );
  });

  it('reads the code from stdin', async () => {
    const dataDir = await temporaryDirectory();
    spawnCli(
      [
        'cloud',
        'bootstrap',
        '--enrollment-code-file',
        '-',
        '--cloud-base-url',
        cloud.baseUrl,
        '--data-dir',
        dataDir,
      ],
      { env, stdin: cloud.issueCode() },
    );
    await waitFor(() => (cloud.connections.length === 1 ? true : undefined), {
      timeout: 20_000,
    });
    expect(cloud.machines.get('machine-1')).toBeDefined();
  });
});

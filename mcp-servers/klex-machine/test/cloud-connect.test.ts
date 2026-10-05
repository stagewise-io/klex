import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectMachine } from '../src/cloud/connect.js';
import { ENROLLMENT_FILE, IDENTITY_FILE } from '../src/cloud/state.js';

const CLOUD = 'https://cloud.example';
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-machine-connect-'));
  directories.push(directory);
  return directory;
}

function enrollmentResponse(machineId = 'machine-1'): Response {
  return Response.json({
    machineId,
    clientId: `oauth-${machineId}`,
    tokenEndpoint: `${CLOUD}/api/auth/oauth2/token`,
    proxyConnectionResource: `${CLOUD}/machine-connections`,
    proxyConnectionUrl: 'wss://cloud.example/machine-connections',
    mcpResourceUrl: `${CLOUD}/machines/${machineId}/mcp`,
    oauthProtectedResourceUrl: `${CLOUD}/machines/${machineId}/mcp/oauth-protected-resource`,
  });
}

type FetchInit = Parameters<typeof globalThis.fetch>[1];

function requestJwk(init: FetchInit): unknown {
  const body = JSON.parse(String(init?.body)) as {
    jwks: { keys: unknown[] };
  };
  return body.jwks.keys[0];
}

async function readEnrollment(
  directory: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(directory, ENROLLMENT_FILE), 'utf8'),
  ) as Record<string, unknown>;
}

async function enrollOnce(directory: string, code = 'first-code') {
  return connectMachine({
    cloudBaseUrl: CLOUD,
    code,
    dataDir: directory,
    fetch: async () => enrollmentResponse(),
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe('connectMachine', () => {
  it('enrolls and stores only a hash of the code', async () => {
    const directory = await temporaryDirectory();
    const fetch = vi.fn(async () => enrollmentResponse());
    const result = await connectMachine({
      cloudBaseUrl: CLOUD,
      code: 'secret-code-123',
      dataDir: directory,
      fetch,
    });

    expect(result.reused).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    const text = await readFile(join(directory, ENROLLMENT_FILE), 'utf8');
    expect(text).not.toContain('secret-code-123');
    expect((await readEnrollment(directory)).enrollmentCodeSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('reuses the enrollment when the same code is run again', async () => {
    const directory = await temporaryDirectory();
    await enrollOnce(directory);

    const fetch = vi.fn(async () => enrollmentResponse());
    const result = await connectMachine({
      cloudBaseUrl: `${CLOUD}/`,
      code: ' first-code \n',
      dataDir: directory,
      fetch,
    });

    expect(result).toMatchObject({
      reused: true,
      enrollment: { machineId: 'machine-1' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('re-enrolls with the existing key when the code changes', async () => {
    const directory = await temporaryDirectory();
    const firstJwks: unknown[] = [];
    await connectMachine({
      cloudBaseUrl: CLOUD,
      code: 'first-code',
      dataDir: directory,
      fetch: async (_input, init) => {
        firstJwks.push(requestJwk(init));
        return enrollmentResponse();
      },
    });
    const firstHash = (await readEnrollment(directory)).enrollmentCodeSha256;

    const secondJwks: unknown[] = [];
    const result = await connectMachine({
      cloudBaseUrl: CLOUD,
      code: 'second-code',
      dataDir: directory,
      fetch: async (_input, init) => {
        secondJwks.push(requestJwk(init));
        return enrollmentResponse('machine-2');
      },
    });

    expect(result).toMatchObject({
      reused: false,
      enrollment: { machineId: 'machine-2' },
    });
    expect(secondJwks).toEqual(firstJwks);
    const stored = await readEnrollment(directory);
    expect(stored.machineId).toBe('machine-2');
    expect(stored.enrollmentCodeSha256).not.toBe(firstHash);
  });

  it('re-enrolls when the same code targets a different cloud', async () => {
    const directory = await temporaryDirectory();
    await enrollOnce(directory);

    const fetch = vi.fn(async () => enrollmentResponse());
    await connectMachine({
      cloudBaseUrl: 'https://other-cloud.example',
      code: 'first-code',
      dataDir: directory,
      fetch,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps the existing enrollment when Cloud rejects a new code', async () => {
    const directory = await temporaryDirectory();
    await enrollOnce(directory);
    const before = await readFile(join(directory, ENROLLMENT_FILE), 'utf8');

    const error = await connectMachine({
      cloudBaseUrl: CLOUD,
      code: 'used-secret-code',
      dataDir: directory,
      fetch: async () => new Response(null, { status: 401 }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('invalid, expired, or already used');
    expect(message).toContain('machine-1');
    expect(message).toContain('klex-machine');
    expect(message).not.toContain('used-secret-code');
    expect(await readFile(join(directory, ENROLLMENT_FILE), 'utf8')).toBe(
      before,
    );
  });

  it('explains a conflicting machine identity', async () => {
    const directory = await temporaryDirectory();
    await expect(
      connectMachine({
        cloudBaseUrl: CLOUD,
        code: 'code',
        dataDir: directory,
        fetch: async () => new Response(null, { status: 409 }),
      }),
    ).rejects.toThrow('Delete it there');
  });

  it('reuses a key left behind by a failed attempt', async () => {
    const directory = await temporaryDirectory();
    const jwks: unknown[] = [];
    await expect(
      connectMachine({
        cloudBaseUrl: CLOUD,
        code: 'code',
        dataDir: directory,
        fetch: async (_input, init) => {
          jwks.push(requestJwk(init));
          return new Response(null, { status: 503 });
        },
      }),
    ).rejects.toThrow('HTTP 503');
    const key = await readFile(join(directory, IDENTITY_FILE), 'utf8');

    await connectMachine({
      cloudBaseUrl: CLOUD,
      code: 'code',
      dataDir: directory,
      fetch: async (_input, init) => {
        jwks.push(requestJwk(init));
        return enrollmentResponse();
      },
    });

    expect(jwks[1]).toEqual(jwks[0]);
    expect(await readFile(join(directory, IDENTITY_FILE), 'utf8')).toBe(key);
  });

  it('fails closed when enrollment exists without a private key', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'identity'));
    await writeFile(join(directory, ENROLLMENT_FILE), '{}');
    const fetch = vi.fn(async () => enrollmentResponse());

    await expect(
      connectMachine({
        cloudBaseUrl: CLOUD,
        code: 'code',
        dataDir: directory,
        fetch,
      }),
    ).rejects.toThrow('private key is missing');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when the key does not match enrollment metadata', async () => {
    const directory = await temporaryDirectory();
    await enrollOnce(directory);
    const enrollment = await readEnrollment(directory);
    enrollment.keyId = 'different-key';
    await writeFile(
      join(directory, ENROLLMENT_FILE),
      `${JSON.stringify(enrollment)}\n`,
    );
    const fetch = vi.fn(async () => enrollmentResponse());

    await expect(
      connectMachine({
        cloudBaseUrl: CLOUD,
        code: 'first-code',
        dataDir: directory,
        fetch,
      }),
    ).rejects.toThrow('does not match enrollment metadata');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails closed when machine state cannot be accessed',
    async () => {
      const directory = await temporaryDirectory();
      await enrollOnce(directory);
      const fetch = vi.fn(async () => enrollmentResponse());
      await chmod(directory, 0o000);
      try {
        await expect(
          connectMachine({
            cloudBaseUrl: CLOUD,
            code: 'new-code',
            dataDir: directory,
            fetch,
          }),
        ).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await chmod(directory, 0o700);
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid stored code hash as corrupt metadata', async () => {
    const directory = await temporaryDirectory();
    await enrollOnce(directory);
    const enrollment = await readEnrollment(directory);
    enrollment.enrollmentCodeSha256 = 'not-a-hash';
    await writeFile(
      join(directory, ENROLLMENT_FILE),
      `${JSON.stringify(enrollment)}\n`,
    );

    await expect(enrollOnce(directory)).rejects.toThrow(
      'Machine enrollment metadata is corrupt',
    );
  });
});

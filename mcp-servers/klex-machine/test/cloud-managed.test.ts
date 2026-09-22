import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootstrapManagedMachine } from '../src/cloud/managed.js';
import { ENROLLMENT_FILE } from '../src/cloud/state.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-machine-managed-'));
  directories.push(directory);
  return directory;
}

function enrollmentResponse(): Response {
  return Response.json({
    machineId: 'machine-1',
    clientId: 'oauth-client-1',
    tokenEndpoint: 'https://cloud.example/api/auth/oauth2/token',
    proxyConnectionResource: 'https://cloud.example/machine-connections',
    proxyConnectionUrl: 'wss://cloud.example/machine-connections',
    mcpResourceUrl: 'https://cloud.example/machines/machine-1/mcp',
    oauthProtectedResourceUrl:
      'https://cloud.example/machines/machine-1/mcp/oauth-protected-resource',
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe('managed machine bootstrap', () => {
  it('consumes a protected code file and enrolls once', async () => {
    const directory = await temporaryDirectory();
    const codeFile = join(directory, 'enrollment-code');
    await writeFile(codeFile, 'one-time-secret\n', { mode: 0o600 });
    const fetch = vi.fn(
      async (
        _input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        expect(init?.body).toContain('one-time-secret');
        return enrollmentResponse();
      },
    );

    const enrollment = await bootstrapManagedMachine({
      cloudBaseUrl: 'https://cloud.example',
      dataDir: directory,
      enrollmentCodeFile: codeFile,
      fetch,
    });

    expect(enrollment.machineId).toBe('machine-1');
    expect(fetch).toHaveBeenCalledOnce();
    await expect(access(codeFile)).rejects.toThrow();
  });

  it('restarts from matching identity without re-enrollment', async () => {
    const directory = await temporaryDirectory();
    const firstCodeFile = join(directory, 'first-code');
    await writeFile(firstCodeFile, 'first-secret');
    await bootstrapManagedMachine({
      cloudBaseUrl: 'https://cloud.example',
      dataDir: directory,
      enrollmentCodeFile: firstCodeFile,
      fetch: async () => enrollmentResponse(),
    });

    const restartCodeFile = join(directory, 'restart-code');
    await writeFile(restartCodeFile, 'must-not-be-used');
    const fetch = vi.fn(async () => enrollmentResponse());
    await bootstrapManagedMachine({
      cloudBaseUrl: 'https://cloud.example/',
      dataDir: directory,
      enrollmentCodeFile: restartCodeFile,
      fetch,
    });

    expect(fetch).not.toHaveBeenCalled();
    await expect(access(restartCodeFile)).rejects.toThrow();
  });

  it('fails closed when identity does not match enrollment metadata', async () => {
    const directory = await temporaryDirectory();
    const firstCodeFile = join(directory, 'first-code');
    await writeFile(firstCodeFile, 'first-secret');
    await bootstrapManagedMachine({
      cloudBaseUrl: 'https://cloud.example',
      dataDir: directory,
      enrollmentCodeFile: firstCodeFile,
      fetch: async () => enrollmentResponse(),
    });

    const enrollmentPath = join(directory, ENROLLMENT_FILE);
    const enrollment = JSON.parse(
      await readFile(enrollmentPath, 'utf8'),
    ) as Record<string, unknown>;
    enrollment.keyId = 'different-key';
    await writeFile(enrollmentPath, `${JSON.stringify(enrollment)}\n`);

    const restartCodeFile = join(directory, 'restart-code');
    await writeFile(restartCodeFile, 'must-not-be-used');
    const fetch = vi.fn(async () => enrollmentResponse());
    await expect(
      bootstrapManagedMachine({
        cloudBaseUrl: 'https://cloud.example',
        dataDir: directory,
        enrollmentCodeFile: restartCodeFile,
        fetch,
      }),
    ).rejects.toThrow('does not match enrollment metadata');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when persisted enrollment belongs to another cloud', async () => {
    const directory = await temporaryDirectory();
    const firstCodeFile = join(directory, 'first-code');
    await writeFile(firstCodeFile, 'first-secret');
    await bootstrapManagedMachine({
      cloudBaseUrl: 'https://cloud.example',
      dataDir: directory,
      enrollmentCodeFile: firstCodeFile,
      fetch: async () => enrollmentResponse(),
    });

    const replacementCodeFile = join(directory, 'replacement-code');
    await writeFile(replacementCodeFile, 'replacement-secret');
    const fetch = vi.fn(async () => enrollmentResponse());
    await expect(
      bootstrapManagedMachine({
        cloudBaseUrl: 'https://other-cloud.example',
        dataDir: directory,
        enrollmentCodeFile: replacementCodeFile,
        fetch,
      }),
    ).rejects.toThrow('different cloud deployment');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when a private key exists without enrollment metadata', async () => {
    const directory = await temporaryDirectory();
    const firstCodeFile = join(directory, 'first-code');
    await writeFile(firstCodeFile, 'first-secret');
    await expect(
      bootstrapManagedMachine({
        cloudBaseUrl: 'https://cloud.example',
        dataDir: directory,
        enrollmentCodeFile: firstCodeFile,
        fetch: async () => new Response(null, { status: 503 }),
      }),
    ).rejects.toThrow('HTTP 503');

    const retryCodeFile = join(directory, 'retry-code');
    await writeFile(retryCodeFile, 'must-not-be-used');
    const fetch = vi.fn(async () => enrollmentResponse());
    await expect(
      bootstrapManagedMachine({
        cloudBaseUrl: 'https://cloud.example',
        dataDir: directory,
        enrollmentCodeFile: retryCodeFile,
        fetch,
      }),
    ).rejects.toThrow('enrollment metadata is missing');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when enrollment exists without a private key', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'identity'));
    await writeFile(join(directory, ENROLLMENT_FILE), '{}');

    await expect(
      bootstrapManagedMachine({
        cloudBaseUrl: 'https://cloud.example',
        dataDir: directory,
        enrollmentCodeFile: '-',
        readStdin: async () => 'secret',
      }),
    ).rejects.toThrow('private key is missing');
  });

  it('removes and redacts a code when enrollment fails', async () => {
    const directory = await temporaryDirectory();
    const codeFile = join(directory, 'enrollment-code');
    const secret = 'never-log-this-code';
    await writeFile(codeFile, secret);

    const result = bootstrapManagedMachine({
      cloudBaseUrl: 'https://cloud.example',
      dataDir: directory,
      enrollmentCodeFile: codeFile,
      fetch: async () => new Response(null, { status: 503 }),
    });

    await expect(result).rejects.not.toThrow(secret);
    await expect(access(codeFile)).rejects.toThrow();
  });

  it('accepts a one-time code through stdin', async () => {
    const directory = await temporaryDirectory();
    const readStdin = vi.fn(async () => 'stdin-secret');
    await bootstrapManagedMachine({
      cloudBaseUrl: 'https://cloud.example',
      dataDir: directory,
      enrollmentCodeFile: '-',
      fetch: async () => enrollmentResponse(),
      readStdin,
    });
    expect(readStdin).toHaveBeenCalledOnce();
  });
});

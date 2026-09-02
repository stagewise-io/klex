import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createCloudConnectivity } from './cloud-connectivity';

const logging = createLogger({ name: 'klex', type: 'hidden' });

const directories: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'klex-cloud-test-'));
  directories.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    directories.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Mock the enrollment module so we don't hit real network
vi.mock('./enrollment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./enrollment')>();
  return {
    ...actual,
    performEnrollment: vi.fn(),
    promptEnrollmentCode: vi.fn(),
  };
});

// Import the mocked functions for test control
import { performEnrollment, promptEnrollmentCode } from './enrollment';

describe('CloudConnectivity', () => {
  let dir: string;

  it('trusts only the exact configured Cloud authorization server', () => {
    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: '/unused',
      cloudEnabled: true,
      cloudBaseUrl: 'https://preview.example/deployment',
      enrollmentToken: undefined,
    });

    expect(
      cloud.isTrustedAuthorizationServer('https://preview.example/api/auth'),
    ).toBe(true);
    expect(
      cloud.isTrustedAuthorizationServer('https://preview.example/api/auth/'),
    ).toBe(false);
    expect(
      cloud.isTrustedAuthorizationServer('https://cloud.klex.bot/api/auth'),
    ).toBe(false);
    expect(cloud.isTrustedAuthorizationServer('not a URL')).toBe(false);
  });

  beforeEach(async () => {
    dir = await makeTempDir();
    vi.mocked(performEnrollment).mockReset();
    vi.mocked(promptEnrollmentCode).mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('cloud disabled: identity created, no enrollment, getAccessToken throws', async () => {
    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: false,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
    });

    await cloud.start();

    expect(cloud.isCloudEnabled()).toBe(false);
    expect(cloud.isEnrolled()).toBe(false);

    await expect(
      cloud.getAccessToken('https://api.klex.bot', ['mcp:use']),
    ).rejects.toThrow('Cloud connectivity is disabled');

    await cloud.close();
  });

  it('cloud enabled, not enrolled, no token, not TTY: warns and continues', async () => {
    vi.mocked(promptEnrollmentCode).mockResolvedValue(null);

    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
    });

    await cloud.start();

    expect(cloud.isCloudEnabled()).toBe(true);
    expect(cloud.isEnrolled()).toBe(false);

    await expect(
      cloud.getAccessToken('https://api.klex.bot', ['mcp:use']),
    ).rejects.toThrow('Agent is not enrolled');

    await cloud.close();
  });

  it('cloud enabled, not enrolled, headless token provided: enrolls successfully', async () => {
    vi.mocked(performEnrollment).mockResolvedValue('client-123');

    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: 'ABCD-EFGH',
    });

    await cloud.start();

    expect(cloud.isEnrolled()).toBe(true);
    expect(performEnrollment).toHaveBeenCalledWith(
      'https://cloud.klex.bot',
      'ABCD-EFGH',
      expect.objectContaining({ algorithm: 'EdDSA' }),
    );

    await cloud.close();
  });

  it('cloud enabled, headless token fails: startup throws', async () => {
    vi.mocked(performEnrollment).mockRejectedValue(
      new Error('Enrollment failed (400): invalid code'),
    );

    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: 'INVALID-CODE',
    });

    await expect(cloud.start()).rejects.toThrow('Headless enrollment failed');

    await cloud.close();
  });

  it('cloud enabled, interactive enrollment fails: retries then user cancels', async () => {
    vi.mocked(promptEnrollmentCode)
      .mockResolvedValueOnce('USER-INPUT')
      .mockResolvedValueOnce(null);
    vi.mocked(performEnrollment).mockRejectedValue(
      new Error('Enrollment failed (400): invalid code'),
    );

    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
    });

    // Should not throw — user cancelled after first failure
    await cloud.start();

    expect(cloud.isEnrolled()).toBe(false);
    expect(promptEnrollmentCode).toHaveBeenCalledTimes(2);
    expect(performEnrollment).toHaveBeenCalledTimes(1);

    await cloud.close();
  });

  it('cloud enabled, interactive enrollment retries then succeeds', async () => {
    vi.mocked(promptEnrollmentCode)
      .mockResolvedValueOnce('BAD-CODE')
      .mockResolvedValueOnce('GOOD-CODE');
    vi.mocked(performEnrollment)
      .mockRejectedValueOnce(new Error('Enrollment failed (400): invalid code'))
      .mockResolvedValueOnce('client-retry-ok');

    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
    });

    await cloud.start();

    expect(cloud.isEnrolled()).toBe(true);
    expect(performEnrollment).toHaveBeenCalledTimes(2);
    expect(performEnrollment).toHaveBeenLastCalledWith(
      'https://cloud.klex.bot',
      'GOOD-CODE',
      expect.objectContaining({ algorithm: 'EdDSA' }),
    );

    await cloud.close();
  });

  it('cloud enabled, already enrolled: initializes token client', async () => {
    // First: enroll successfully
    vi.mocked(performEnrollment).mockResolvedValue('client-456');

    const cloud1 = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: 'ABCD-EFGH',
    });
    await cloud1.start();
    await cloud1.close();

    // Second start: should find existing enrollment, not re-enroll
    vi.mocked(performEnrollment).mockClear();
    vi.mocked(promptEnrollmentCode).mockReset();

    const cloud2 = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
    });
    await cloud2.start();

    expect(cloud2.isEnrolled()).toBe(true);
    expect(performEnrollment).not.toHaveBeenCalled();

    await cloud2.close();
  });

  it('identity rotation: stale enrollment (kid mismatch) triggers re-enrollment', async () => {
    // First: enroll successfully
    vi.mocked(performEnrollment).mockResolvedValue('client-789');

    const cloud1 = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: 'ABCD-EFGH',
    });
    await cloud1.start();
    await cloud1.close();

    // Verify enrollment was saved
    const enrollmentRaw = await readFile(
      join(dir, 'identity', 'enrollment.json'),
      'utf8',
    );
    const savedEnrollment = JSON.parse(enrollmentRaw) as {
      clientId: string;
      kid: string;
    };
    expect(savedEnrollment.clientId).toBe('client-789');

    // Simulate identity rotation: overwrite metadata.json with a new kid
    // while keeping the private key untouched.
    const metadataPath = join(dir, 'identity', 'metadata.json');
    const metadataRaw = await readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(metadataRaw) as { kid: string };
    const rotatedKid = `klex-key-rotated-${Date.now()}`;
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, kid: rotatedKid }),
      'utf8',
    );

    // Second start: enrollment kid no longer matches identity kid.
    // The stale enrollment should be detected and re-enrollment triggered.
    vi.mocked(performEnrollment).mockResolvedValue('client-rotated');

    const cloud2 = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: 'NEW-TOKEN',
    });
    await cloud2.start();

    expect(cloud2.isEnrolled()).toBe(true);
    expect(performEnrollment).toHaveBeenCalledWith(
      'https://cloud.klex.bot',
      'NEW-TOKEN',
      expect.objectContaining({ kid: rotatedKid }),
    );

    await cloud2.close();
  });

  it('close is idempotent', async () => {
    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: false,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
    });

    await cloud.start();
    await cloud.close();
    // Second close should not throw
    await cloud.close();
  });

  it('start is idempotent', async () => {
    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: false,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
    });

    await cloud.start();
    // Second start should not throw
    await cloud.start();

    await cloud.close();
  });
});

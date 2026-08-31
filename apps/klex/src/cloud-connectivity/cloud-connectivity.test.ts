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

const {
  cloudApiClientMock,
  connectAgentTunnelMock,
  createCloudApiClientMock,
  getAccessTokenMock,
  invalidateTokenMock,
  tokenClientCloseMock,
  tunnelCloseMock,
  tunnelHandlers,
  tunnelOnMock,
} = vi.hoisted(() => {
  const cloudApiClientMock = { agent: { tunnel: {} } };
  const createCloudApiClientMock = vi.fn(() => cloudApiClientMock);
  const tunnelHandlers: Record<string, (...args: unknown[]) => void> = {};
  const tunnelMock = { close: vi.fn(), on: vi.fn() };
  const tunnelOnMock = tunnelMock.on.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      tunnelHandlers[event] = handler;
      return tunnelMock;
    },
  );
  return {
    cloudApiClientMock,
    connectAgentTunnelMock: vi.fn(async () => tunnelMock),
    createCloudApiClientMock,
    getAccessTokenMock: vi.fn(async () => 'mock-access-token'),
    invalidateTokenMock: vi.fn(),
    tokenClientCloseMock: vi.fn(),
    tunnelCloseMock: tunnelMock.close,
    tunnelHandlers,
    tunnelOnMock,
  };
});

vi.mock('@klex/cloud-api', () => ({
  connectAgentTunnel: connectAgentTunnelMock,
  createCloudApiClient: createCloudApiClientMock,
}));

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

// Mock the token client to prevent real OAuth discovery and token requests.
// The mock returns a fake token immediately.
vi.mock('./token-client', () => ({
  createTokenClient: vi.fn(() => ({
    getAccessToken: getAccessTokenMock,
    invalidate: invalidateTokenMock,
    close: tokenClientCloseMock,
  })),
}));

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
      allowDangerousUnsecureCloud: false,
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
    connectAgentTunnelMock.mockReset();
    connectAgentTunnelMock.mockImplementation(async () => ({
      close: tunnelCloseMock,
      on: tunnelOnMock,
    }));
    createCloudApiClientMock.mockClear();
    getAccessTokenMock.mockReset();
    getAccessTokenMock.mockResolvedValue('mock-access-token');
    invalidateTokenMock.mockClear();
    tokenClientCloseMock.mockClear();
    tunnelCloseMock.mockClear();
    tunnelOnMock.mockClear();
    for (const event of Object.keys(tunnelHandlers))
      delete tunnelHandlers[event];
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function startEnrolledCloud() {
    vi.mocked(performEnrollment).mockResolvedValue('client-123');
    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: 'ABCD-EFGH',
      allowDangerousUnsecureCloud: false,
    });
    await cloud.start();
    return cloud;
  }

  it('cloud disabled: identity created, no enrollment, getAccessToken throws', async () => {
    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: false,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
    });

    await cloud.start();

    expect(cloud.isEnrolled()).toBe(true);
    expect(performEnrollment).toHaveBeenCalledWith(
      'https://cloud.klex.bot',
      'ABCD-EFGH',
      expect.objectContaining({ algorithm: 'EdDSA' }),
    );
    expect(createCloudApiClientMock).toHaveBeenCalledWith(
      'https://cloud.klex.bot',
      expect.objectContaining({ headers: expect.any(Function) }),
    );
    expect(cloud.getApiClient()).toBe(cloudApiClientMock);
    expect(connectAgentTunnelMock).toHaveBeenCalledWith(
      'https://cloud.klex.bot/v1',
      { accessToken: 'mock-access-token' },
    );
    expect(getAccessTokenMock).toHaveBeenCalledWith(
      'https://cloud.klex.bot/v1',
      ['agent:access'],
    );

    await cloud.close();
    expect(tunnelCloseMock).toHaveBeenCalled();
  });

  it('uses the requested resource and scopes for non-tunnel tokens', async () => {
    const cloud = await startEnrolledCloud();
    const resource = 'https://mcp.cloud.klex.bot/server';

    await expect(cloud.getAccessToken(resource, ['mcp:access'])).resolves.toBe(
      'mock-access-token',
    );
    cloud.invalidateAccessToken(resource);

    expect(getAccessTokenMock).toHaveBeenLastCalledWith(resource, [
      'mcp:access',
    ]);
    expect(invalidateTokenMock).toHaveBeenCalledWith(resource);

    await cloud.close();
  });

  it('does not block application startup while fetching a tunnel token', async () => {
    getAccessTokenMock.mockImplementation(() => new Promise(() => {}));

    const cloud = await startEnrolledCloud();

    expect(cloud.isEnrolled()).toBe(true);
    expect(getAccessTokenMock).toHaveBeenCalledOnce();
    expect(connectAgentTunnelMock).not.toHaveBeenCalled();

    await cloud.close();
  });

  it('retries when access token fetching fails', async () => {
    vi.useFakeTimers();
    getAccessTokenMock.mockRejectedValueOnce(new Error('token unavailable'));
    const cloud = await startEnrolledCloud();

    expect(connectAgentTunnelMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(connectAgentTunnelMock).toHaveBeenCalledOnce();

    await cloud.close();
  });

  it('backs off repeated access token failures up to 30 seconds', async () => {
    vi.useFakeTimers();
    getAccessTokenMock.mockRejectedValue(new Error('token unavailable'));
    const cloud = await startEnrolledCloud();

    expect(getAccessTokenMock).toHaveBeenCalledTimes(1);

    for (const [delay, expectedCalls] of [
      [1_000, 2],
      [2_000, 3],
      [4_000, 4],
      [8_000, 5],
      [16_000, 6],
      [30_000, 7],
      [30_000, 8],
    ] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(getAccessTokenMock).toHaveBeenCalledTimes(expectedCalls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(getAccessTokenMock).toHaveBeenCalledTimes(expectedCalls);
    }

    await cloud.close();
  });

  it('retries when the package tunnel connection fails', async () => {
    vi.useFakeTimers();
    connectAgentTunnelMock.mockRejectedValueOnce(
      new Error('tunnel unavailable'),
    );
    const cloud = await startEnrolledCloud();

    expect(connectAgentTunnelMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connectAgentTunnelMock).toHaveBeenCalledTimes(2);

    await cloud.close();
  });

  it('reconnects through the package with a fresh token after disconnect', async () => {
    vi.useFakeTimers();
    const cloud = await startEnrolledCloud();

    tunnelHandlers.open?.();
    tunnelHandlers.close?.(1006, Buffer.from('connection lost'));

    expect(invalidateTokenMock).toHaveBeenCalledWith(
      'https://cloud.klex.bot/v1',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(connectAgentTunnelMock).toHaveBeenCalledTimes(2);

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
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
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
      allowDangerousUnsecureCloud: false,
    });

    await cloud.start();
    // Second start should not throw
    await cloud.start();

    await cloud.close();
  });

  it('rejects http cloud base URL when allowDangerousUnsecureCloud is false', async () => {
    vi.mocked(performEnrollment).mockResolvedValue('client-insecure');

    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'http://insecure.klex.bot',
      enrollmentToken: 'ABCD-EFGH',
      allowDangerousUnsecureCloud: false,
    });

    await expect(cloud.start()).rejects.toThrow('must use https://');
    await cloud.close();
  });

  it('allows http cloud base URL when allowDangerousUnsecureCloud is true', async () => {
    vi.mocked(performEnrollment).mockResolvedValue('client-insecure-ok');

    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'http://insecure.klex.bot',
      enrollmentToken: 'ABCD-EFGH',
      allowDangerousUnsecureCloud: true,
    });

    // Should not throw on the http scheme — tunnel flow is best-effort
    await cloud.start();
    expect(cloud.isEnrolled()).toBe(true);
    await cloud.close();
  });

  it('invalidateAccessToken does not throw when not enrolled', async () => {
    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: false,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
      allowDangerousUnsecureCloud: false,
    });

    await cloud.start();
    // Should be a no-op — tokenClient is null
    expect(() =>
      cloud.invalidateAccessToken('https://api.klex.bot'),
    ).not.toThrow();
    await cloud.close();
  });
});

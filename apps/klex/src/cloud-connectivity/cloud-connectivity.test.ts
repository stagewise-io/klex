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
  startAgentTunnelMock,
  createCloudApiClientMock,
  getAccessTokenMock,
  invalidateTokenMock,
  tokenClientCloseMock,
  tunnelStopMock,
  tunnelHandlers,
  tunnelOptionsRef,
} = vi.hoisted(() => {
  const cloudApiClientMock = { agent: { tunnel: {} } };
  const createCloudApiClientMock = vi.fn(() => cloudApiClientMock);
  const tunnelHandlers: Record<string, (...args: unknown[]) => void> = {};
  const tunnelOptionsRef: {
    current: {
      accessToken?: string | (() => string | Promise<string>);
      reconnect?: boolean;
      reconnectDelayMs?: number;
      maxReconnectDelayMs?: number;
      onRequest?: (request: Request) => Response | Promise<Response>;
    };
  } = { current: {} };
  const tunnelStopMock = vi.fn(async () => undefined);
  const startAgentTunnelMock = vi.fn(
    async (options: {
      accessToken: string | (() => string | Promise<string>);
      onRequest?: (request: Request) => Response | Promise<Response>;
      onConnect?: () => void;
      onClose?: (code: number, reason: string) => void;
      onError?: (error: Error) => void;
    }) => {
      if (typeof options.accessToken === 'function')
        await options.accessToken();
      tunnelOptionsRef.current = options;
      tunnelHandlers.open = options.onConnect ?? (() => undefined);
      tunnelHandlers.close = (...args) =>
        options.onClose?.(args[0] as number, args[1] as string);
      tunnelHandlers.error = (...args) => options.onError?.(args[0] as Error);
      return { agentId: null, stop: tunnelStopMock };
    },
  );
  return {
    cloudApiClientMock,
    startAgentTunnelMock,
    createCloudApiClientMock,
    getAccessTokenMock: vi.fn(async () => 'mock-access-token'),
    invalidateTokenMock: vi.fn(),
    tokenClientCloseMock: vi.fn(),
    tunnelStopMock,
    tunnelHandlers,
    tunnelOptionsRef,
  };
});

vi.mock('@klex/cloud-api', () => ({
  startAgentTunnel: startAgentTunnelMock,
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
    startAgentTunnelMock.mockReset();
    startAgentTunnelMock.mockImplementation(
      async (options: {
        accessToken: string | (() => string | Promise<string>);
        onRequest?: (request: Request) => Response | Promise<Response>;
        onConnect?: () => void;
        onClose?: (code: number, reason: string) => void;
        onError?: (error: Error) => void;
      }) => {
        if (typeof options.accessToken === 'function')
          await options.accessToken();
        tunnelOptionsRef.current = options;
        tunnelHandlers.open = options.onConnect ?? (() => undefined);
        tunnelHandlers.close = (...args) =>
          options.onClose?.(args[0] as number, args[1] as string);
        tunnelHandlers.error = (...args) => options.onError?.(args[0] as Error);
        return { agentId: null, stop: tunnelStopMock };
      },
    );
    createCloudApiClientMock.mockClear();
    getAccessTokenMock.mockReset();
    getAccessTokenMock.mockResolvedValue('mock-access-token');
    invalidateTokenMock.mockClear();
    tokenClientCloseMock.mockClear();
    tunnelStopMock.mockClear();
    for (const event of Object.keys(tunnelHandlers))
      delete tunnelHandlers[event];
    tunnelOptionsRef.current = {};
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
    expect(cloud.getTunnelState()).toBe('connecting');
    expect(startAgentTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://cloud.klex.bot/v1',
        accessToken: expect.any(Function),
        reconnect: true,
        reconnectDelayMs: 1_000,
        maxReconnectDelayMs: 30_000,
        onRequest: expect.any(Function),
      }),
    );
    expect(getAccessTokenMock).toHaveBeenCalledWith(
      'https://cloud.klex.bot/v1',
      ['agent:access'],
    );

    // Tunnel open event should transition state to 'connected'
    tunnelHandlers.open?.();
    expect(cloud.getTunnelState()).toBe('connected');

    await cloud.close();
    expect(tunnelStopMock).toHaveBeenCalled();
    expect(cloud.getTunnelState()).toBe('disconnected');
  });

  it('routes tunnel requests through the Admin API handler', async () => {
    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: 'ABCD-EFGH',
      allowDangerousUnsecureCloud: false,
    });
    vi.mocked(performEnrollment).mockResolvedValueOnce('client-1');
    const handler = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe('/v1/test');
      expect(new URL(request.url).search).toBe('?stream=1');
      expect(request.headers.get('x-test')).toBe('yes');
      expect(await request.text()).toBe('request-body');
      return new Response('response-body', {
        status: 201,
        headers: { 'x-response': 'yes' },
      });
    });
    cloud.setTunnelRequestHandler(handler);
    await cloud.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = await tunnelOptionsRef.current.onRequest?.(
      new Request('https://agent.invalid/v1/test?stream=1', {
        method: 'POST',
        headers: { 'x-test': 'yes' },
        body: 'request-body',
      }),
    );
    expect(response?.status).toBe(201);
    expect(response?.headers.get('x-response')).toBe('yes');
    expect(await response?.text()).toBe('response-body');
    expect(handler).toHaveBeenCalledOnce();
    await cloud.close();
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
    expect(startAgentTunnelMock).toHaveBeenCalledOnce();

    await cloud.close();
  });

  it('retries when access token fetching fails', async () => {
    vi.useFakeTimers();
    getAccessTokenMock.mockRejectedValueOnce(new Error('token unavailable'));
    const cloud = await startEnrolledCloud();

    expect(cloud.getTunnelState()).toBe('error');
    expect(startAgentTunnelMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getAccessTokenMock).toHaveBeenCalledTimes(2);
    expect(startAgentTunnelMock).toHaveBeenCalledTimes(2);

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
    startAgentTunnelMock.mockImplementationOnce(async (options) => {
      if (typeof options.accessToken === 'function')
        await options.accessToken();
      throw new Error('tunnel unavailable');
    });
    const cloud = await startEnrolledCloud();

    expect(startAgentTunnelMock).toHaveBeenCalledOnce();
    expect(getAccessTokenMock).toHaveBeenCalledOnce();
    expect(invalidateTokenMock).toHaveBeenCalledWith(
      'https://cloud.klex.bot/v1',
    );
    expect(cloud.getTunnelState()).toBe('error');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startAgentTunnelMock).toHaveBeenCalledTimes(2);
    expect(getAccessTokenMock).toHaveBeenCalledTimes(2);

    await cloud.close();
  });

  it('delegates reconnect backoff to the package and supplies fresh tokens', async () => {
    vi.useFakeTimers();
    const cloud = await startEnrolledCloud();

    tunnelHandlers.open?.();
    expect(cloud.getTunnelState()).toBe('connected');

    tunnelHandlers.close?.(1006, Buffer.from('connection lost'));
    expect(cloud.getTunnelState()).toBe('error');
    expect(invalidateTokenMock).toHaveBeenCalledWith(
      'https://cloud.klex.bot/v1',
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(startAgentTunnelMock).toHaveBeenCalledOnce();

    const accessToken = tunnelOptionsRef.current.accessToken;
    expect(accessToken).toBeTypeOf('function');
    await (accessToken as () => string | Promise<string>)();
    expect(getAccessTokenMock).toHaveBeenCalledTimes(2);

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

  it('cloud enabled, interactive enrollment via enroll() fails: throws error', async () => {
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

    await cloud.start();
    expect(cloud.isEnrolled()).toBe(false);

    // Interactive enrollment via enroll() — CLI UI handles retry/cancel
    await expect(cloud.enroll('USER-INPUT')).rejects.toThrow(
      'Enrollment failed (400): invalid code',
    );
    expect(cloud.isEnrolled()).toBe(false);
    expect(performEnrollment).toHaveBeenCalledTimes(1);

    await cloud.close();
  });

  it('cloud enabled, interactive enrollment via enroll() succeeds', async () => {
    vi.mocked(performEnrollment).mockResolvedValue('client-retry-ok');

    const cloud = createCloudConnectivity({
      logging,
      dataDirectory: dir,
      cloudEnabled: true,
      cloudBaseUrl: 'https://cloud.klex.bot',
      enrollmentToken: undefined,
      allowDangerousUnsecureCloud: false,
    });

    await cloud.start();
    expect(cloud.isEnrolled()).toBe(false);

    // First attempt fails (simulated by mock reset)
    vi.mocked(performEnrollment).mockRejectedValueOnce(
      new Error('Enrollment failed (400): invalid code'),
    );

    // CLI UI would retry — second call to enroll() with a good code
    await expect(cloud.enroll('BAD-CODE')).rejects.toThrow();
    const result = await cloud.enroll('GOOD-CODE');

    expect(cloud.isEnrolled()).toBe(true);
    expect(result.clientId).toBe('client-retry-ok');
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

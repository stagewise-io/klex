import {
  type CloudApiClient,
  connectAgentTunnel,
  createCloudApiClient,
} from '@klex/cloud-api';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  loadEnrollmentState,
  performEnrollment,
  saveEnrollmentState,
} from './enrollment';
import { importPrivateKey, loadOrCreateIdentity } from './identity';
import { createTokenClient, type TokenClient } from './token-client';
import type {
  CloudConnectivity,
  CloudIdentity,
  EnrollmentResult,
  EnrollmentState,
  TunnelState,
} from './types';

export interface CloudConnectivityDependencies {
  logging: RootLogger;
  dataDirectory: string;
  cloudEnabled: boolean;
  cloudBaseUrl: string;
  enrollmentToken: string | undefined;
  allowDangerousUnsecureCloud: boolean;
}

const CLOUD_API_SCOPES = ['agent:access'];

/** The OAuth `resource` parameter for all token requests. Both tunnel and
 * public API tokens are scoped to the cloud API surface at `/v1`. */
const API_RESOURCE_PATH = '/v1';
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;

class CloudConnectivityModule implements CloudConnectivity {
  private identity: CloudIdentity | null = null;
  private enrollment: EnrollmentState | null = null;
  private tokenClient: TokenClient | null = null;
  private cloudApiClient: CloudApiClient | null = null;
  private tunnel: Awaited<ReturnType<typeof connectAgentTunnel>> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private connecting = false;
  private started = false;
  private tunnelState: TunnelState = 'disconnected';

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      dataDirectory: string;
      cloudEnabled: boolean;
      cloudBaseUrl: string;
      enrollmentToken: string | undefined;
      allowDangerousUnsecureCloud: boolean;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Identity is always created, regardless of cloud mode
    this.identity = await loadOrCreateIdentity(
      this.deps.dataDirectory,
      this.deps.logger,
    );

    if (!this.deps.cloudEnabled) {
      this.deps.logger.info(
        { kid: this.identity.kid },
        'Cloud connectivity disabled — identity keypair ready',
      );
      return;
    }

    // Validate cloud base URL scheme
    if (!this.deps.cloudBaseUrl.startsWith('https://')) {
      if (this.deps.allowDangerousUnsecureCloud) {
        this.deps.logger.warn(
          { cloudBaseUrl: this.deps.cloudBaseUrl },
          'Using an unsecure (http) cloud base URL — a secure (https) connection is strongly preferred. Token and key material may be exposed to network interception.',
        );
      } else {
        throw new Error(
          `Cloud base URL must use https:// (got: ${this.deps.cloudBaseUrl}). Use --allow-dangerous-unsecure-cloud to override at your own risk.`,
        );
      }
    }

    // Cloud enabled — load enrollment state
    this.enrollment = loadEnrollmentState(
      this.deps.dataDirectory,
      this.identity.kid,
    );

    if (this.enrollment.clientId === null) {
      // Not enrolled — try headless enrollment if a token was provided.
      // Interactive enrollment is handled by the CLI UI; we do not block
      // startup with a readline prompt here.
      if (this.deps.enrollmentToken) {
        await this.enrollHeadless(this.identity);
        if (this.enrollment.clientId === null) {
          return;
        }
      } else {
        this.deps.logger.warn(
          { kid: this.identity.kid },
          'Not enrolled in Klex Cloud and no enrollment token provided. Cloud features will be unavailable. To enroll, use the CLI UI or restart with --cloud-enroll-token.',
        );
        return;
      }
    }

    // Enrolled — initialize token client
    const privateKey = await importPrivateKey(this.identity);
    this.tokenClient = createTokenClient({
      logger: this.deps.logger,
      cloudBaseUrl: this.deps.cloudBaseUrl,
      clientId: this.enrollment.clientId,
      privateKey,
      privateKeyKid: this.identity.kid,
      allowDangerousUnsecureCloud: this.deps.allowDangerousUnsecureCloud,
    });

    this.cloudApiClient = createCloudApiClient(this.deps.cloudBaseUrl, {
      headers: async () => ({
        authorization: `Bearer ${await this.getAccessToken(this.apiResource(), CLOUD_API_SCOPES)}`,
      }),
    });

    this.deps.logger.info(
      { clientId: this.enrollment.clientId },
      'Klex Cloud connectivity enabled; tunnel connecting',
    );

    // Token acquisition and tunnel establishment are best-effort background
    // work and must never block the rest of application startup.
    void this.connectTunnel();
  }

  private async connectTunnel(): Promise<void> {
    if (!this.started || this.connecting || !this.tokenClient) return;
    this.connecting = true;

    try {
      let accessToken: string;
      this.tunnelState = 'connecting';
      try {
        accessToken = await this.tokenClient.getAccessToken(
          this.apiResource(),
          CLOUD_API_SCOPES,
        );
      } catch {
        if (!this.started) return;
        const retryDelayMs = this.scheduleReconnect();
        this.deps.logger.warn(
          { retryAttempt: this.retryAttempt, retryDelayMs },
          'Klex Cloud tunnel access token unavailable; retrying',
        );
        return;
      }
      if (!this.started) return;

      const tunnel = await connectAgentTunnel(this.apiResource(), {
        accessToken,
      });
      if (!this.started) {
        tunnel.close();
        return;
      }

      this.tunnel = tunnel;
      tunnel.on('open', () => {
        if (this.tunnel !== tunnel || !this.started) return;
        this.retryAttempt = 0;
        this.tunnelState = 'connected';
        this.deps.logger.info(
          { clientId: this.enrollment?.clientId },
          'Klex Cloud tunnel connected',
        );
      });
      tunnel.on('error', (error: unknown) => {
        if (this.tunnel !== tunnel || !this.started) return;
        this.tunnel = null;
        this.tunnelState = 'error';
        this.tokenClient?.invalidate(this.apiResource());
        const retryDelayMs = this.scheduleReconnect();
        this.deps.logger.error(
          { error, retryAttempt: this.retryAttempt, retryDelayMs },
          'Klex Cloud tunnel error; retrying',
        );
        tunnel.close();
      });
      tunnel.on('close', (code: unknown, reason: unknown) => {
        if (this.tunnel !== tunnel || !this.started) return;
        this.tunnel = null;
        this.tunnelState = 'error';
        this.tokenClient?.invalidate(this.apiResource());
        const retryDelayMs = this.scheduleReconnect();
        this.deps.logger.warn(
          {
            code,
            reason: String(reason),
            retryAttempt: this.retryAttempt,
            retryDelayMs,
          },
          'Klex Cloud tunnel disconnected; retrying',
        );
      });
    } catch (error) {
      if (!this.started) return;
      this.tunnelState = 'error';
      const retryDelayMs = this.scheduleReconnect();
      this.deps.logger.error(
        { error, retryAttempt: this.retryAttempt, retryDelayMs },
        'Klex Cloud tunnel connection failed; retrying',
      );
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): number | null {
    if (!this.started || this.retryTimer) return null;
    const delay = Math.min(
      RETRY_INITIAL_MS * 2 ** this.retryAttempt,
      RETRY_MAX_MS,
    );
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectTunnel();
    }, delay);
    this.retryTimer.unref?.();
    return delay;
  }

  private async enrollHeadless(identity: CloudIdentity): Promise<void> {
    const enrollmentToken = this.deps.enrollmentToken;
    if (!enrollmentToken) return;

    this.deps.logger.info('Enrolling agent in Klex Cloud (headless mode)');
    try {
      const clientId = await performEnrollment(
        this.deps.cloudBaseUrl,
        enrollmentToken,
        identity,
      );
      await this.persistEnrollment(clientId, identity.kid);
    } catch (error) {
      this.deps.logger.error({ error }, 'Headless cloud enrollment failed');
      throw new Error(
        `Headless enrollment failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async enroll(enrollmentCode: string): Promise<EnrollmentResult> {
    if (!this.identity) {
      throw new Error('Cloud connectivity has not been started');
    }
    if (!this.deps.cloudEnabled) {
      throw new Error('Cloud connectivity is disabled');
    }

    const clientId = await performEnrollment(
      this.deps.cloudBaseUrl,
      enrollmentCode,
      this.identity,
    );
    await this.persistEnrollment(clientId, this.identity.kid);
    await this.initTokenClient();

    this.cloudApiClient = createCloudApiClient(this.deps.cloudBaseUrl, {
      headers: async () => ({
        authorization: `Bearer ${await this.getAccessToken(this.apiResource(), CLOUD_API_SCOPES)}`,
      }),
    });

    void this.connectTunnel();

    return {
      clientId,
      enrolledAt: this.enrollment?.enrolledAt ?? new Date().toISOString(),
    };
  }

  private async persistEnrollment(
    clientId: string,
    kid: string,
  ): Promise<void> {
    this.enrollment = {
      clientId,
      enrolledAt: new Date().toISOString(),
      kid,
    };
    await saveEnrollmentState(this.deps.dataDirectory, this.enrollment);
    this.deps.logger.info({ clientId }, 'Enrollment successful');
  }

  private async initTokenClient(): Promise<void> {
    if (!this.identity || !this.enrollment?.clientId) return;
    const privateKey = await importPrivateKey(this.identity);
    this.tokenClient = createTokenClient({
      logger: this.deps.logger,
      cloudBaseUrl: this.deps.cloudBaseUrl,
      clientId: this.enrollment.clientId,
      privateKey,
      privateKeyKid: this.identity.kid,
      allowDangerousUnsecureCloud: this.deps.allowDangerousUnsecureCloud,
    });
  }

  getEnrollmentState(): EnrollmentState {
    if (this.enrollment) {
      return { ...this.enrollment };
    }
    return {
      clientId: null,
      enrolledAt: null,
      kid: this.identity?.kid ?? '',
    };
  }

  getCloudBaseUrl(): string {
    return this.deps.cloudBaseUrl;
  }

  async getAccessToken(resource: string, scopes: string[]): Promise<string> {
    if (!this.deps.cloudEnabled) {
      throw new Error('Cloud connectivity is disabled');
    }
    if (!this.tokenClient) {
      throw new Error('Agent is not enrolled in Klex Cloud');
    }
    return this.tokenClient.getAccessToken(resource, scopes);
  }

  invalidateAccessToken(resource: string): void {
    this.tokenClient?.invalidate(resource);
  }

  getApiClient(): CloudApiClient {
    if (!this.cloudApiClient) {
      throw new Error('Klex Cloud API client is not initialized');
    }
    return this.cloudApiClient;
  }

  isEnrolled(): boolean {
    return this.enrollment?.clientId != null;
  }

  isCloudEnabled(): boolean {
    return this.deps.cloudEnabled;
  }

  isTrustedAuthorizationServer(issuer: string): boolean {
    try {
      const expectedIssuer = new URL(
        '/api/auth',
        this.deps.cloudBaseUrl,
      ).toString();
      return new URL(issuer).toString() === expectedIssuer;
    } catch {
      return false;
    }
  }

  getTunnelState(): TunnelState {
    return this.tunnelState;
  }

  private apiResource(): string {
    return `${this.deps.cloudBaseUrl.replace(/\/$/, '')}${API_RESOURCE_PATH}`;
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAttempt = 0;
    this.connecting = false;
    this.tunnel?.close();
    this.tunnel = null;
    this.tunnelState = 'disconnected';
    this.cloudApiClient = null;

    this.tokenClient?.close();
    this.tokenClient = null;

    this.identity = null;
    this.enrollment = null;

    this.deps.logger.info('Cloud connectivity stopped');
  }
}

export function createCloudConnectivity(
  deps: CloudConnectivityDependencies,
): CloudConnectivity {
  return new CloudConnectivityModule({
    logger: deps.logging.child({
      name: 'cloud-connectivity',
      bindings: { module: 'cloud-connectivity' },
    }),
    dataDirectory: deps.dataDirectory,
    cloudEnabled: deps.cloudEnabled,
    cloudBaseUrl: deps.cloudBaseUrl,
    enrollmentToken: deps.enrollmentToken,
    allowDangerousUnsecureCloud: deps.allowDangerousUnsecureCloud,
  });
}

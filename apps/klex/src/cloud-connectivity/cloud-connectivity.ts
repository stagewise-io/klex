import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  loadEnrollmentState,
  performEnrollment,
  promptEnrollmentCode,
  saveEnrollmentState,
} from './enrollment';
import { importPrivateKey, loadOrCreateIdentity } from './identity';
import { createTokenClient, type TokenClient } from './token-client';
import type {
  CloudConnectivity,
  CloudIdentity,
  EnrollmentState,
} from './types';

export interface CloudConnectivityDependencies {
  logging: RootLogger;
  dataDirectory: string;
  cloudEnabled: boolean;
  cloudBaseUrl: string;
  enrollmentToken: string | undefined;
}

class CloudConnectivityModule implements CloudConnectivity {
  private identity: CloudIdentity | null = null;
  private enrollment: EnrollmentState | null = null;
  private tokenClient: TokenClient | null = null;
  private started = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      dataDirectory: string;
      cloudEnabled: boolean;
      cloudBaseUrl: string;
      enrollmentToken: string | undefined;
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

    // Cloud enabled — load enrollment state
    this.enrollment = loadEnrollmentState(
      this.deps.dataDirectory,
      this.identity.kid,
    );

    if (this.enrollment.clientId === null) {
      await this.handleEnrollment();
      // If enrollment failed in interactive mode, enrollment.clientId stays null
      if (this.enrollment.clientId === null) {
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
    });

    this.deps.logger.info(
      { clientId: this.enrollment.clientId },
      'Klex Cloud connectivity enabled',
    );
  }

  private async handleEnrollment(): Promise<void> {
    const identity = this.identity;
    if (!identity) return;

    if (this.deps.enrollmentToken) {
      await this.enrollHeadless(identity);
    } else {
      await this.enrollInteractive(identity);
    }
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
      throw new Error(
        `Headless enrollment failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async enrollInteractive(identity: CloudIdentity): Promise<void> {
    for (;;) {
      const enrollmentCode = await promptEnrollmentCode(this.deps.logger);
      if (enrollmentCode === null) {
        this.deps.logger.warn(
          'Not enrolled in Klex Cloud and no enrollment code available. Cloud features will be unavailable. To enroll, restart with --cloud-enroll-token or KLEX_CLOUD_ENROLLMENT_TOKEN.',
        );
        return;
      }

      this.deps.logger.info('Enrolling agent in Klex Cloud');

      try {
        const clientId = await performEnrollment(
          this.deps.cloudBaseUrl,
          enrollmentCode,
          identity,
        );
        await this.persistEnrollment(clientId, identity.kid);
        return;
      } catch (error) {
        this.deps.logger.error(
          { error },
          'Enrollment failed — please try again with a new code',
        );
      }
    }
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

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;

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
  });
}

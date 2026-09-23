import type { CloudApiClient } from '@klex/cloud-api';
export type CloudAlgorithm = 'EdDSA';

export interface CloudIdentity {
  privateKeyPem: string;
  kid: string;
  algorithm: CloudAlgorithm;
}

export interface EnrollmentState {
  clientId: string | null;
  enrolledAt: string | null;
  kid: string;
}

export interface EnrollmentResult {
  clientId: string;
  enrolledAt: string;
}

export type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface CloudConnectivity {
  setTunnelRequestHandler(
    handler: (request: Request) => Response | Promise<Response>,
  ): void;
  start(): Promise<void>;
  /**
   * Announces shutdown to Klex Cloud: closes the tunnel gracefully, waits
   * (bounded) for the close handshake, and disables reconnects. Outbound token
   * acquisition keeps working until {@link close}, so other modules can still
   * shut down authenticated connections. Idempotent.
   */
  disconnect(): Promise<void>;
  close(): Promise<void>;
  getAccessToken(resource: string, scopes: string[]): Promise<string>;
  invalidateAccessToken(resource: string): void;
  getApiClient(): CloudApiClient;
  isEnrolled(): boolean;
  isCloudEnabled(): boolean;
  isTrustedAuthorizationServer(issuer: string): boolean;
  getEnrollmentState(): EnrollmentState;
  getCloudBaseUrl(): string;
  enroll(enrollmentCode: string): Promise<EnrollmentResult>;
  getTunnelState(): TunnelState;
}

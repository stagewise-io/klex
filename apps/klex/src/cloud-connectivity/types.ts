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

export interface CloudConnectivity {
  start(): Promise<void>;
  close(): Promise<void>;
  getAccessToken(resource: string, scopes: string[]): Promise<string>;
  invalidateAccessToken(resource: string): void;
  isEnrolled(): boolean;
  isCloudEnabled(): boolean;
  isTrustedAuthorizationServer(issuer: string): boolean;
}

import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  generateMachineIdentity,
  loadMachineIdentity,
  saveMachineIdentity,
} from './identity.js';
import {
  ENROLLMENT_FILE,
  hashEnrollmentCode,
  IDENTITY_FILE,
  type MachineEnrollment,
  saveMachineEnrollment,
} from './state.js';

export interface EnrollMachineOptions {
  cloudBaseUrl: string;
  code: string;
  dataDir: string;
  fetch?: typeof globalThis.fetch;
}

export class EnrollmentRejectedError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EnrollmentRejectedError';
    this.status = status;
  }
}

function rejectionError(status: number): Error {
  if (status === 401) {
    return new EnrollmentRejectedError(
      401,
      'Enrollment code is invalid, expired, or already used. Generate a new code in Cloud.',
    );
  }
  if (status === 409) {
    return new EnrollmentRejectedError(
      409,
      'This machine is already enrolled in Cloud. Delete it there, then run the command with a new code.',
    );
  }
  return new Error(`Machine enrollment failed with HTTP ${status}`);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Enrollment response has invalid ${key}`);
  }
  return value;
}

function parseResponse(
  value: unknown,
  cloudBaseUrl: string,
  keyId: string,
): MachineEnrollment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Enrollment response is invalid');
  }
  const record = value as Record<string, unknown>;
  return {
    version: 1,
    keyId,
    machineId: requiredString(record, 'machineId'),
    clientId: requiredString(record, 'clientId'),
    cloudBaseUrl,
    enrolledAt: new Date().toISOString(),
    tokenEndpoint: requiredString(record, 'tokenEndpoint'),
    proxyConnectionResource: requiredString(record, 'proxyConnectionResource'),
    proxyConnectionUrl: requiredString(record, 'proxyConnectionUrl'),
    mcpResourceUrl: requiredString(record, 'mcpResourceUrl'),
    oauthProtectedResourceUrl: requiredString(
      record,
      'oauthProtectedResourceUrl',
    ),
  };
}

export async function enrollMachine(
  options: EnrollMachineOptions,
): Promise<MachineEnrollment> {
  const cloudBaseUrl = options.cloudBaseUrl.replace(/\/$/, '');
  const code = options.code.trim();
  if (!code) throw new Error('Enrollment code is required');

  const identityPath = join(options.dataDir, IDENTITY_FILE);
  const hasIdentity = await access(identityPath).then(
    () => true,
    () => false,
  );
  const identity = hasIdentity
    ? await loadMachineIdentity(identityPath)
    : await generateMachineIdentity();
  if (!hasIdentity) await saveMachineIdentity(identityPath, identity);

  const response = await (options.fetch ?? globalThis.fetch)(
    `${cloudBaseUrl}/api/machines/enroll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollmentCode: code,
        jwks: { keys: [identity.publicJwk] },
      }),
    },
  );
  if (!response.ok) throw rejectionError(response.status);

  const enrollment: MachineEnrollment = {
    ...parseResponse(
      await response.json(),
      cloudBaseUrl,
      identity.privateKeyKid,
    ),
    enrollmentCodeSha256: hashEnrollmentCode(code),
  };
  await saveMachineEnrollment(options.dataDir, enrollment);
  return enrollment;
}

export { ENROLLMENT_FILE };

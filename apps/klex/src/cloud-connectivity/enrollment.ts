import * as readline from 'node:readline/promises';

import type { ModuleLogger } from '@stagewise/logger';

import { publicKeyToJwks } from './identity';
import {
  CLOUD_ENROLLMENT_STORE_DEFINITION,
  readCloudJsonFile,
  writeSecureJsonFile,
} from './storage';
import type { CloudIdentity, EnrollmentState } from './types';

export async function loadEnrollmentState(
  dataDirectory: string,
  kid: string,
): Promise<EnrollmentState> {
  try {
    const parsed = await readCloudJsonFile<EnrollmentState>(
      dataDirectory,
      CLOUD_ENROLLMENT_STORE_DEFINITION,
    );
    if (!parsed) return { clientId: null, enrolledAt: null, kid };
    // If the kid doesn't match the current identity, the enrollment is
    // stale (e.g. identity was rotated or metadata was regenerated).
    if (parsed.kid !== kid) {
      return { clientId: null, enrolledAt: null, kid };
    }
    return parsed;
  } catch {
    return { clientId: null, enrolledAt: null, kid };
  }
}

export async function saveEnrollmentState(
  dataDirectory: string,
  state: EnrollmentState,
): Promise<void> {
  await writeSecureJsonFile(
    dataDirectory,
    CLOUD_ENROLLMENT_STORE_DEFINITION,
    state,
  );
}

export async function performEnrollment(
  cloudBaseUrl: string,
  enrollmentCode: string,
  identity: CloudIdentity,
): Promise<string> {
  const jwks = await publicKeyToJwks(identity);
  const response = await fetch(`${cloudBaseUrl}/api/agents/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enrollmentCode, jwks }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown error');
    throw new Error(`Enrollment failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { clientId?: string };
  if (!data.clientId) {
    throw new Error('Enrollment response missing clientId');
  }
  return data.clientId;
}

export async function promptEnrollmentCode(
  logger: ModuleLogger,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    logger.warn(
      'No TTY available — cannot prompt for enrollment code interactively',
    );
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Enter enrollment code: ');
    const trimmed = answer.trim();
    if (!trimmed) {
      logger.warn('Enrollment code not provided — skipping enrollment');
      return null;
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

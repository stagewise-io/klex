import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';

import type { ModuleLogger } from '@stagewise/logger';

import { publicKeyToJwks } from './identity';
import { IDENTITY_DIR, writeSecureJsonFile } from './storage';
import type { CloudIdentity, EnrollmentState } from './types';

const ENROLLMENT_FILE = 'enrollment.json';

export function loadEnrollmentState(
  dataDirectory: string,
  kid: string,
): EnrollmentState {
  const enrollmentPath = join(dataDirectory, IDENTITY_DIR, ENROLLMENT_FILE);
  try {
    const raw = readFileSync(enrollmentPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      clientId: string | null;
      enrolledAt: string | null;
      kid: string;
    };
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
  const enrollmentPath = join(dataDirectory, IDENTITY_DIR, ENROLLMENT_FILE);
  await writeSecureJsonFile(enrollmentPath, state);
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

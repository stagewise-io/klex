import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type EnrollMachineOptions,
  EnrollmentRejectedError,
  enrollMachine,
} from './enrollment.js';
import { validateEnrollmentIdentity } from './managed.js';
import {
  ENROLLMENT_FILE,
  hashEnrollmentCode,
  IDENTITY_FILE,
  loadMachineEnrollment,
  type MachineEnrollment,
} from './state.js';

export interface ConnectMachineResult {
  enrollment: MachineEnrollment;
  reused: boolean;
}

// Only ENOENT means missing. Other errors (e.g. EACCES) must fail closed so an
// unreadable data dir never spends a one-time code on a fresh enrollment.
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function loadExistingEnrollment(
  dataDir: string,
): Promise<MachineEnrollment | undefined> {
  const [hasIdentity, hasEnrollment] = await Promise.all([
    exists(join(dataDir, IDENTITY_FILE)),
    exists(join(dataDir, ENROLLMENT_FILE)),
  ]);
  if (hasEnrollment && !hasIdentity) {
    throw new Error('Machine state is incomplete: private key is missing');
  }
  // A key without enrollment metadata is the normal state after a failed
  // attempt; enrollMachine() reuses that key.
  if (!hasEnrollment) return undefined;

  const enrollment = await loadMachineEnrollment(dataDir);
  await validateEnrollmentIdentity(dataDir, enrollment);
  return enrollment;
}

/**
 * Enrolls the machine unless the same code was already used for the same
 * Cloud deployment, so re-running the copied command restarts the machine.
 * The existing identity key is always reused.
 */
export async function connectMachine(
  options: EnrollMachineOptions,
): Promise<ConnectMachineResult> {
  const cloudBaseUrl = options.cloudBaseUrl.replace(/\/$/, '');
  const code = options.code.trim();
  if (!code) throw new Error('Enrollment code is required');

  const existing = await loadExistingEnrollment(options.dataDir);
  if (
    existing &&
    existing.cloudBaseUrl === cloudBaseUrl &&
    existing.enrollmentCodeSha256 === hashEnrollmentCode(code)
  ) {
    return { enrollment: existing, reused: true };
  }

  try {
    const enrollment = await enrollMachine({ ...options, cloudBaseUrl, code });
    return { enrollment, reused: false };
  } catch (error) {
    if (
      existing &&
      error instanceof EnrollmentRejectedError &&
      error.status === 401
    ) {
      throw new EnrollmentRejectedError(
        401,
        `${error.message} Existing enrollment for machine ${existing.machineId} is unchanged; start it with: klex-machine`,
        { cause: error },
      );
    }
    throw error;
  }
}

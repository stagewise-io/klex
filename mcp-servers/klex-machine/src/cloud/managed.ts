import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { type EnrollMachineOptions, enrollMachine } from './enrollment.js';
import { loadMachineIdentity } from './identity.js';
import {
  ENROLLMENT_FILE,
  IDENTITY_FILE,
  loadMachineEnrollment,
  type MachineEnrollment,
} from './state.js';

export interface ManagedBootstrapOptions {
  cloudBaseUrl: string;
  dataDir: string;
  enrollmentCodeFile: string;
  fetch?: EnrollMachineOptions['fetch'];
  readStdin?: () => Promise<string>;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function loadExistingEnrollment(
  dataDir: string,
): Promise<MachineEnrollment | undefined> {
  const identityPath = join(dataDir, IDENTITY_FILE);
  const enrollmentPath = join(dataDir, ENROLLMENT_FILE);
  const [hasIdentity, hasEnrollment] = await Promise.all([
    exists(identityPath),
    exists(enrollmentPath),
  ]);

  if (hasEnrollment && !hasIdentity) {
    throw new Error(
      'Managed machine state is incomplete: private key is missing',
    );
  }
  if (!hasEnrollment) return undefined;

  const [identity, enrollment] = await Promise.all([
    loadMachineIdentity(identityPath),
    loadMachineEnrollment(dataDir),
  ]);
  if (identity.privateKeyKid !== enrollment.keyId) {
    throw new Error(
      'Managed machine identity does not match enrollment metadata',
    );
  }
  return enrollment;
}

async function consumeEnrollmentCode(
  path: string,
  readStdin: () => Promise<string>,
): Promise<string> {
  if (path === '-') return readStdin();
  try {
    return await readFile(path, 'utf8');
  } finally {
    await rm(path, { force: true });
  }
}

export async function bootstrapManagedMachine(
  options: ManagedBootstrapOptions,
): Promise<MachineEnrollment> {
  const existing = await loadExistingEnrollment(options.dataDir);
  if (existing) {
    if (options.enrollmentCodeFile !== '-') {
      await rm(options.enrollmentCodeFile, { force: true });
    }
    return existing;
  }

  const code = await consumeEnrollmentCode(
    options.enrollmentCodeFile,
    options.readStdin ?? defaultReadStdin,
  );
  const enrollment = await enrollMachine({
    cloudBaseUrl: options.cloudBaseUrl,
    code,
    dataDir: options.dataDir,
    fetch: options.fetch,
  });
  const identity = await loadMachineIdentity(
    join(options.dataDir, IDENTITY_FILE),
  );
  if (identity.privateKeyKid !== enrollment.keyId) {
    throw new Error(
      'Managed machine identity does not match enrollment metadata',
    );
  }
  return enrollment;
}

import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const IDENTITY_FILE = 'identity/private-key.pem';
export const ENROLLMENT_FILE = 'identity/enrollment.json';

export interface MachineEnrollment {
  version: 1;
  keyId: string;
  machineId: string;
  clientId: string;
  cloudBaseUrl: string;
  enrolledAt: string;
  tokenEndpoint: string;
  proxyConnectionResource: string;
  proxyConnectionUrl: string;
  mcpResourceUrl: string;
  oauthProtectedResourceUrl: string;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Machine enrollment metadata has invalid ${name}`);
  }
  return value;
}

export function parseMachineEnrollment(value: unknown): MachineEnrollment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Machine enrollment metadata is corrupt');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(
      `Unsupported machine enrollment version: ${String(record.version)}`,
    );
  }
  return {
    version: 1,
    keyId: nonEmpty(record.keyId, 'keyId'),
    machineId: nonEmpty(record.machineId, 'machineId'),
    clientId: nonEmpty(record.clientId, 'clientId'),
    cloudBaseUrl: nonEmpty(record.cloudBaseUrl, 'cloudBaseUrl'),
    enrolledAt: nonEmpty(record.enrolledAt, 'enrolledAt'),
    tokenEndpoint: nonEmpty(record.tokenEndpoint, 'tokenEndpoint'),
    proxyConnectionResource: nonEmpty(
      record.proxyConnectionResource,
      'proxyConnectionResource',
    ),
    proxyConnectionUrl: nonEmpty(
      record.proxyConnectionUrl,
      'proxyConnectionUrl',
    ),
    mcpResourceUrl: nonEmpty(record.mcpResourceUrl, 'mcpResourceUrl'),
    oauthProtectedResourceUrl: nonEmpty(
      record.oauthProtectedResourceUrl,
      'oauthProtectedResourceUrl',
    ),
  };
}

export async function loadMachineEnrollment(
  dataDir: string,
): Promise<MachineEnrollment> {
  const path = join(dataDir, ENROLLMENT_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Machine is not enrolled: ${path}`, { cause: error });
  }
  try {
    return parseMachineEnrollment(JSON.parse(text));
  } catch (error) {
    throw new Error(`Machine enrollment metadata is corrupt: ${path}`, {
      cause: error,
    });
  }
}

export async function saveMachineEnrollment(
  dataDir: string,
  enrollment: MachineEnrollment,
): Promise<void> {
  const path = join(dataDir, ENROLLMENT_FILE);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(enrollment, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

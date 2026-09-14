import { join } from 'node:path';

import {
  createProxyDaemon,
  type ProxyDaemon,
  type ProxyEnvironmentHandler,
} from '@stagewise/mcp-proxy-sdk/daemon/node';

import { loadMachineIdentity } from './identity.js';
import { IDENTITY_FILE, loadMachineEnrollment } from './state.js';
import { createMachineTokenClient } from './token-client.js';

export interface CloudMachineRuntime {
  readonly daemon: ProxyDaemon;
  close(): Promise<void>;
}

export async function startCloudMachineRuntime(
  dataDir: string,
  handler: ProxyEnvironmentHandler,
): Promise<CloudMachineRuntime> {
  const enrollment = await loadMachineEnrollment(dataDir);
  const identity = await loadMachineIdentity(join(dataDir, IDENTITY_FILE));
  if (identity.privateKeyKid !== enrollment.keyId) {
    throw new Error('Machine private key does not match enrollment metadata');
  }
  const tokenClient = createMachineTokenClient({
    clientId: enrollment.clientId,
    privateKey: identity.privateKey,
    keyId: identity.privateKeyKid,
    tokenEndpoint: enrollment.tokenEndpoint,
    resource: enrollment.proxyConnectionResource,
  });
  const daemon = createProxyDaemon({
    connection: async () => ({
      url: enrollment.proxyConnectionUrl,
      headers: { authorization: `Bearer ${await tokenClient.getToken()}` },
    }),
    handler,
    reconnect: {},
  });
  try {
    await daemon.start();
  } catch (error) {
    tokenClient.close();
    throw error;
  }
  return {
    daemon,
    async close() {
      tokenClient.close();
      await daemon.close();
    },
  };
}

import { join } from 'node:path';

import {
  createProxyDaemon,
  type ProxyDaemon,
  type ProxyEnvironmentHandler,
} from '@klex/mcp-proxy-sdk/daemon/node';

import { type MachineLogger, silentMachineLogger } from '../logger.js';
import {
  createMachineFactsCollector,
  encodeMachineFactsHeader,
  MACHINE_FACTS_HEADER,
  type MachineFactsOptions,
} from './facts/index.js';
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
  options?: MachineFactsOptions & { logger?: MachineLogger },
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
  const collector = options ? createMachineFactsCollector(options) : undefined;
  const logger = options?.logger ?? silentMachineLogger;
  const daemon = createProxyDaemon({
    connection: async () => {
      tokenClient.invalidate();
      const token = await tokenClient.getToken();
      let factsHeader: string | undefined;
      if (collector) {
        try {
          factsHeader = encodeMachineFactsHeader(await collector.collect());
          if (!factsHeader)
            logger.warn('Machine facts exceed header size limit');
        } catch {
          logger.warn('Machine facts collection failed');
        }
      }
      return {
        url: enrollment.proxyConnectionUrl,
        headers: {
          authorization: `Bearer ${token}`,
          ...(factsHeader ? { [MACHINE_FACTS_HEADER]: factsHeader } : {}),
        },
      };
    },
    handler,
    reconnect: {},
  });
  try {
    await daemon.start();
  } catch (error) {
    tokenClient.close();
    await daemon.close();
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

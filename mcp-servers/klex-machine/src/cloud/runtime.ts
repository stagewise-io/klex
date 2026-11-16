import { join } from 'node:path';

import {
  createProxyDaemon,
  type ProxyDaemon,
  type ProxyEnvironmentHandler,
} from '@klex/mcp-proxy-sdk/daemon/node';

import type { DesktopService } from '../desktop/index.js';
import { type MachineLogger, silentMachineLogger } from '../logger.js';
import { type DesktopLink, startDesktopLink } from './desktop-link.js';
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
  options?: MachineFactsOptions & {
    logger?: MachineLogger;
    /** Streams this desktop to Cloud viewers and enforces the control lease. */
    desktop?: { service: DesktopService; vncSocketPath?: string };
  },
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
  const desktop = options?.desktop;
  const link: DesktopLink | undefined = desktop
    ? startDesktopLink({
        cloudBaseUrl: enrollment.cloudBaseUrl,
        getToken: () => tokenClient.getToken(),
        invalidateToken: () => tokenClient.invalidate(),
        desktop: desktop.service,
        machineVersion: options?.version ?? 'unknown',
        logger,
        ...(desktop.vncSocketPath
          ? { vncSocketPath: desktop.vncSocketPath }
          : {}),
      })
    : undefined;
  return {
    daemon,
    async close() {
      try {
        await link?.close();
      } finally {
        tokenClient.close();
        desktop?.service.lease.close();
        await daemon.close();
      }
    },
  };
}

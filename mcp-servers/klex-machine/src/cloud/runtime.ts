import { join } from 'node:path';

import {
  createProxyDaemon,
  type ProxyDaemon,
  type ProxyEnvironmentHandler,
} from '@klex/mcp-proxy-sdk/daemon/node';

import type { MachineCatalog } from './catalog.js';
import { createMachineCatalogPublisher } from './catalog-publisher.js';
import { loadMachineIdentity } from './identity.js';
import {
  createMachineLeaseReporter,
  type MachineLeaseReporter,
} from './lease-reporter.js';
import { IDENTITY_FILE, loadMachineEnrollment } from './state.js';
import { createMachineTokenClient } from './token-client.js';

export interface CloudMachineRuntime {
  readonly daemon: ProxyDaemon;
  close(): Promise<void>;
}

export interface CloudMachineRuntimeOptions {
  /**
   * Describe the served MCP surface for the no-wake Cloud catalog.
   * `workloadReporting` is true only when a lease reporter is attached.
   */
  describeCatalog?: (context: {
    workloadReporting: boolean;
  }) => Promise<MachineCatalog>;
  onCatalogError?: (error: unknown) => void;
  /** Receives the lease reporter before the daemon serves any request. */
  attachLeaseReporter?: (reporter: MachineLeaseReporter) => void;
  onLeaseError?: (error: unknown) => void;
}

export async function startCloudMachineRuntime(
  dataDir: string,
  handler: ProxyEnvironmentHandler,
  options: CloudMachineRuntimeOptions = {},
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
  const describeCatalog = options.describeCatalog;
  const attachLeaseReporter = options.attachLeaseReporter;
  const reportUrl = new URL(
    `/api/machines/${encodeURIComponent(enrollment.machineId)}/lifecycle/report`,
    enrollment.cloudBaseUrl,
  ).href;
  const reportTokenClient =
    describeCatalog || attachLeaseReporter
      ? createMachineTokenClient({
          clientId: enrollment.clientId,
          privateKey: identity.privateKey,
          keyId: identity.privateKeyKid,
          tokenEndpoint: enrollment.tokenEndpoint,
          resource: enrollment.proxyConnectionResource,
          scope: 'machine:lifecycle-report',
        })
      : undefined;
  const leases =
    attachLeaseReporter && reportTokenClient
      ? createMachineLeaseReporter({
          reportUrl,
          getToken: () => reportTokenClient.getToken(),
          invalidateToken: () => reportTokenClient.invalidate(),
          ...(options.onLeaseError ? { onError: options.onLeaseError } : {}),
        })
      : undefined;
  if (leases) attachLeaseReporter?.(leases);
  const publisher =
    describeCatalog && reportTokenClient
      ? createMachineCatalogPublisher({
          reportUrl,
          getToken: () => reportTokenClient.getToken(),
          invalidateToken: () => reportTokenClient.invalidate(),
          buildCatalog: () =>
            describeCatalog({ workloadReporting: leases !== undefined }),
          ...(options.onCatalogError
            ? { onError: options.onCatalogError }
            : {}),
        })
      : undefined;
  const closeClients = () => {
    publisher?.close();
    leases?.close();
    reportTokenClient?.close();
    tokenClient.close();
  };
  const daemon = createProxyDaemon({
    connection: async () => {
      tokenClient.invalidate();
      // Every (re)connect may follow a resume or replacement; republish so the
      // Cloud copy always belongs to the generation that is actually serving.
      void publisher?.publish();
      return {
        url: enrollment.proxyConnectionUrl,
        headers: { authorization: `Bearer ${await tokenClient.getToken()}` },
      };
    },
    handler,
    reconnect: {},
  });
  try {
    await daemon.start();
  } catch (error) {
    closeClients();
    await daemon.close();
    throw error;
  }
  return {
    daemon,
    async close() {
      closeClients();
      await daemon.close();
    },
  };
}

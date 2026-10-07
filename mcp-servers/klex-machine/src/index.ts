import {
  helpText,
  machineLiveMessage,
  packageVersion,
  parseCli,
} from './cli.js';
import { createMachineLogger } from './logger.js';
import { createNotificationStore } from './notifications/index.js';

async function main(): Promise<void> {
  const result = await parseCli(process.argv.slice(2));
  if (result.action === 'help') {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (result.action === 'version') {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  if (result.action === 'enroll') {
    const { connectMachine } = await import('./cloud/connect.js');
    const { enrollment, reused } = await connectMachine({
      cloudBaseUrl: result.cloudBaseUrl,
      code: result.code,
      dataDir: result.dataDir,
    });
    process.stdout.write(
      reused
        ? `Already enrolled as machine ${enrollment.machineId}; enrollment code not used again.\n`
        : `Enrolled machine ${enrollment.machineId}\n`,
    );
    if (!result.serve) {
      process.stdout.write('Start it with: klex-machine\n');
      return;
    }
    process.stdout.write('Connecting to Klex Cloud...\n');
  }
  if (result.action === 'managed-bootstrap') {
    const { bootstrapManagedMachine } = await import('./cloud/managed.js');
    await bootstrapManagedMachine({
      cloudBaseUrl: result.cloudBaseUrl,
      dataDir: result.dataDir,
      enrollmentCodeFile: result.enrollmentCodeFile,
    });
  }
  if (result.action === 'serve' && result.mode === 'local') {
    const { startMachineServer } = await import('./server.js');
    await startMachineServer(result.config, { dataDir: result.dataDir });
    return;
  }

  const [
    { createMachineAuthenticator },
    { createPrincipalMcpRouter },
    { loadProtectedResourceConfiguration },
    { startCloudMachineRuntime },
    { loadMachineEnrollment },
    { describeMachineCatalog },
    { createMachineMcp },
  ] = await Promise.all([
    import('./cloud/auth.js'),
    import('./cloud/principal-router.js'),
    import('./cloud/protected-resource.js'),
    import('./cloud/runtime.js'),
    import('./cloud/state.js'),
    import('./cloud/catalog.js'),
    import('./mcp.js'),
  ]);
  const enrollment = await loadMachineEnrollment(result.dataDir);
  const protectedResource = await loadProtectedResourceConfiguration(
    enrollment.oauthProtectedResourceUrl,
    enrollment.mcpResourceUrl,
  );
  const store = createNotificationStore({
    dataDir: result.dataDir,
    logger: createMachineLogger(result.config.logLevel),
  });
  await store.ready();
  const router = createPrincipalMcpRouter(
    createMachineAuthenticator({
      issuer: protectedResource.issuer,
      audience: protectedResource.resource,
      jwksUrl: `${enrollment.cloudBaseUrl}/api/auth/jwks`,
      protectedResourceMetadataUrl: enrollment.oauthProtectedResourceUrl,
    }),
    result.config.cwd,
    store,
  );
  const runtime = await startCloudMachineRuntime(result.dataDir, router, {
    // A private instance answers `tools/list`, so no principal state is created.
    describeCatalog: async ({ workloadReporting }) => {
      const mcp = createMachineMcp(result.config.cwd);
      try {
        return await describeMachineCatalog(mcp, {
          daemonVersion: packageVersion(),
          workloadReporting,
        });
      } finally {
        await mcp.close();
      }
    },
    onCatalogError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `klex-machine: catalog publish failed: ${message}\n`,
      );
    },
    attachLeaseReporter: (reporter) => router.attachLeaseReporter(reporter),
    onLeaseError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`klex-machine: workload lease: ${message}\n`);
    },
  }).catch(async (error: unknown) => {
    try {
      await router.close();
    } finally {
      await store.close();
    }
    throw error;
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await runtime.close();
      } finally {
        try {
          await router.close();
        } finally {
          await store.close();
        }
      }
    })());
  if (result.action !== 'managed-bootstrap') {
    process.stdout.write(`${machineLiveMessage(enrollment.machineId)}\n`);
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void close().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    });
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`klex-machine: ${message}\n`);
  process.exitCode = 1;
});

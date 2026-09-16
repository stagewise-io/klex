import { helpText, packageVersion, parseCli } from './cli.js';

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
    const { enrollMachine } = await import('./cloud/enrollment.js');
    const enrollment = await enrollMachine({
      cloudBaseUrl: result.cloudBaseUrl,
      code: result.code,
      dataDir: result.dataDir,
    });
    process.stdout.write(`Enrolled machine ${enrollment.machineId}\n`);
    return;
  }
  if (result.mode === 'local') {
    const { startMachineServer } = await import('./server.js');
    await startMachineServer(result.config);
    return;
  }

  const [
    { createMachineAuthenticator },
    { createPrincipalMcpRouter },
    { loadProtectedResourceConfiguration },
    { startCloudMachineRuntime },
    { loadMachineEnrollment },
  ] = await Promise.all([
    import('./cloud/auth.js'),
    import('./cloud/principal-router.js'),
    import('./cloud/protected-resource.js'),
    import('./cloud/runtime.js'),
    import('./cloud/state.js'),
  ]);
  const enrollment = await loadMachineEnrollment(result.dataDir);
  const protectedResource = await loadProtectedResourceConfiguration(
    enrollment.oauthProtectedResourceUrl,
    enrollment.mcpResourceUrl,
  );
  const router = createPrincipalMcpRouter(
    createMachineAuthenticator({
      issuer: protectedResource.issuer,
      audience: protectedResource.resource,
      jwksUrl: `${enrollment.cloudBaseUrl}/api/auth/jwks`,
      protectedResourceMetadataUrl: enrollment.oauthProtectedResourceUrl,
    }),
    result.config.cwd,
  );
  const runtime = await startCloudMachineRuntime(result.dataDir, router);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void runtime.close().then(
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

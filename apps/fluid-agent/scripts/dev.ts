import { type ChildProcess, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

import {
  type BuildContext,
  type BuildResult,
  context,
  type Plugin,
} from 'esbuild';

import { createBuildOptions } from '../build';

const RESTART_DELAY_MS = 100;

let child: ChildProcess | undefined;
let contexts: BuildContext[] = [];
let restartTimer: NodeJS.Timeout | undefined;
let restartQueue = Promise.resolve();
let shuttingDown = false;
let watching = false;
const buildSucceeded = new Map<string, boolean>();

function watchPlugin(name: string): Plugin {
  return {
    name: `dev-${name}`,
    setup(build) {
      build.onEnd((result: BuildResult) => {
        buildSucceeded.set(name, result.errors.length === 0);
        if (watching && result.errors.length === 0) {
          scheduleRestart();
        }
      });
    },
  };
}

function scheduleRestart(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    if ([...buildSucceeded.values()].every(Boolean)) {
      restartQueue = restartQueue.then(restartAgent);
    }
  }, RESTART_DELAY_MS);
}

async function stopAgent(): Promise<void> {
  const runningChild = child;
  child = undefined;
  if (!runningChild || runningChild.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    runningChild.once('exit', () => resolve());
    runningChild.kill();
  });
}

async function restartAgent(): Promise<void> {
  if (shuttingDown) {
    return;
  }

  await stopAgent();
  if (shuttingDown) {
    return;
  }

  child = spawn(
    process.execPath,
    ['--env-file=../../.env', 'dist/main.js', ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  child.once('error', (error) => {
    console.error('Failed to start fluid-agent', error);
  });
}

async function shutdown(exitCode = 0): Promise<never> {
  if (shuttingDown) {
    process.exit(exitCode);
  }
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  await stopAgent();
  await Promise.all(contexts.map((buildContext) => buildContext.dispose()));
  process.exit(exitCode);
}

async function main(): Promise<void> {
  await rm('dist', { force: true, recursive: true });

  const options = createBuildOptions(false);
  contexts = await Promise.all([
    context({
      ...options.main,
      plugins: [...(options.main.plugins ?? []), watchPlugin('main')],
    }),
    context({
      ...options.worker,
      plugins: [...(options.worker.plugins ?? []), watchPlugin('worker')],
    }),
  ]);

  await Promise.all(contexts.map((buildContext) => buildContext.rebuild()));
  await restartAgent();
  watching = true;
  await Promise.all(contexts.map((buildContext) => buildContext.watch()));
  console.log('Watching for changes...');
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  await main();
} catch (error) {
  console.error('Development startup failed', error);
  await shutdown(1);
}

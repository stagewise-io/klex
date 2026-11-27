// Maps a pull request's changed files to the CI job groups they can affect.
// Platform-matrix jobs, macOS above all, run only for the groups that are
// affected. Pushes to main run every group, so anything missed here still
// fails on main.

import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
);

// A trailing slash matches a directory prefix; anything else an exact path.
export const globalPaths = [
  '.github/actions/',
  '.github/workflows/ci.yml',
  '.npmrc',
  '.nvmrc',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/',
  'turbo.json',
  'vitest.config.ts',
];

// Root scripts read only by the website or by a single group.
export const globalExclusions = [
  'scripts/agent-site/',
  'scripts/install-e2e.sh',
  'scripts/install-lock-e2e.ps1',
];

const rustPaths = [
  '.cargo/',
  'Cargo.lock',
  'Cargo.toml',
  'rust-toolchain.toml',
];

// `packages` expand to each package's directory and its workspace dependency
// closure. `paths` cover inputs that closure misses, such as files reached
// through tsconfig paths or include_str!.
export const groups = {
  installer: {
    paths: [
      'install.ps1',
      'install.sh',
      'scripts/install-e2e.sh',
      'scripts/install-lock-e2e.ps1',
    ],
  },
  machine: {
    // klex-machine's test tsconfig maps @stagewise/logger to its source.
    packages: [
      '@klex/machine',
      '@klex/machine-conformance',
      '@stagewise/logger',
    ],
    paths: rustPaths,
  },
  'machine-rs': {
    packages: ['@klex/machine-rs'],
    paths: [...rustPaths, 'mcp-servers/klex-machine/contract/'],
  },
  executable: {
    packages: ['@stagewise/klex'],
  },
  // The Tauri crate links klex-machine through Cargo, not pnpm.
  desktop: {
    packages: ['@klex/desktop', '@klex/machine-rs'],
    paths: [...rustPaths, 'mcp-servers/klex-machine/contract/'],
  },
};

export function readWorkspace(root = repositoryRoot) {
  const patterns = [];
  let inPackages = false;
  for (const line of readFileSync(
    join(root, 'pnpm-workspace.yaml'),
    'utf8',
  ).split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages || line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }
    const entry = line.match(/^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/);
    if (!entry) break;
    patterns.push(entry[1]);
  }
  if (patterns.length === 0) {
    throw new Error('No workspace packages found in pnpm-workspace.yaml');
  }

  const workspace = new Map();
  for (const pattern of patterns) {
    if (!/^[\w.-]+\/\*$/.test(pattern)) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(join(root, parent), {
      withFileTypes: true,
    })) {
      const manifestPath = join(root, parent, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const dependencies = Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      })
        .filter(([, version]) => String(version).startsWith('workspace:'))
        .map(([name]) => name);
      workspace.set(manifest.name, {
        path: `${parent}/${entry.name}/`,
        dependencies,
      });
    }
  }
  return workspace;
}

export function packagePaths(workspace, names) {
  const seen = new Set();
  const pending = [...names];
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    const workspacePackage = workspace.get(name);
    if (!workspacePackage) {
      throw new Error(`Unknown workspace package: ${name}`);
    }
    seen.add(name);
    pending.push(...workspacePackage.dependencies);
  }
  return [...seen].map((name) => workspace.get(name).path).sort();
}

function matches(file, paths) {
  return paths.some((path) =>
    path.endsWith('/') ? file.startsWith(path) : file === path,
  );
}

export function affectedGroups(files, workspace) {
  const everything = files.some(
    (file) => matches(file, globalPaths) && !matches(file, globalExclusions),
  );
  return Object.fromEntries(
    Object.entries(groups).map(([group, { packages = [], paths = [] }]) => {
      const groupPaths = [...paths, ...packagePaths(workspace, packages)];
      return [
        group,
        everything || files.some((file) => matches(file, groupPaths)),
      ];
    }),
  );
}

function main() {
  const all = process.argv.includes('--all');
  const files = all
    ? []
    : readFileSync(0, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
  const result = all
    ? Object.fromEntries(Object.keys(groups).map((group) => [group, true]))
    : affectedGroups(files, readWorkspace());

  if (!all) console.log(`${files.length} changed files`);
  const lines = Object.entries(result).map(
    ([group, affected]) => `${group}=${affected}`,
  );
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  main();
}

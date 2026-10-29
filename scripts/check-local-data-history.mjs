import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HISTORY = 'apps/klex/src/local-data-history/';
export const FIXTURES = 'apps/klex/src/local-data-history-fixtures/';
const REGISTRY = `${HISTORY}local-data-history.ts`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root });
const uncomment = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Deliberately a tiny data-only grammar, not eval or a general TS parser.
// Restricting the registry keeps its trusted Git baseline easy to compare.
export function parseRegistry(source) {
  const imports = new Map();
  let body = uncomment(source).replace(
    /import\s*\{([^}]+)\}\s*from\s*'([^']+)'\s*;/g,
    (_, names, path) => {
      if (!path.startsWith('./'))
        throw new Error('Registry imports must be historical relative modules');
      for (const name of names
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)) {
        if (!/^[A-Za-z_$][\w$]*$/.test(name) || imports.has(name))
          throw new Error('Registry needs unique, unaliased named imports');
        imports.set(
          name,
          `${posix.normalize(posix.join(HISTORY, `${path}.ts`))}#${name}`,
        );
      }
      return '';
    },
  );
  body = body.trim();
  if (!body.startsWith('export const LOCAL_DATA_HISTORY ='))
    throw new Error('Expected literal history registry');
  body = body
    .slice('export const LOCAL_DATA_HISTORY ='.length)
    .trim()
    .replace(/;$/, '');
  const tokens = body.match(/'[^']*'|[A-Za-z_$][\w$]*|[{}[\],:]/g) ?? [];
  if (tokens.join('') !== body.replace(/\s/g, ''))
    throw new Error('Unsupported registry expression');
  let offset = 0;
  const take = (expected) => {
    if (tokens[offset++] !== expected)
      throw new Error(`Expected ${expected} in registry`);
  };
  const object = () => {
    take('{');
    const value = {};
    while (tokens[offset] !== '}') {
      const key = tokens[offset++]?.replace(/^'|'$/g, '');
      if (!key || Object.hasOwn(value, key))
        throw new Error('Duplicate or missing registry key');
      take(':');
      if (tokens[offset] === '{') value[key] = object();
      else {
        take('[');
        value[key] = [];
        while (tokens[offset] !== ']') {
          const symbol = tokens[offset++];
          if (!imports.has(symbol))
            throw new Error(`Unknown registry symbol: ${symbol}`);
          value[key].push(imports.get(symbol));
          if (tokens[offset] !== ',') break;
          offset++;
        }
        take(']');
      }
      if (tokens[offset] !== ',') break;
      offset++;
    }
    take('}');
    return value;
  };
  const result = object();
  if (offset !== tokens.length)
    throw new Error('Unexpected code after registry');
  for (const [id, entry] of Object.entries(result)) {
    if (
      !Array.isArray(entry.migrations) ||
      Object.keys(entry).some(
        (key) => !['versions', 'migrations'].includes(key),
      )
    )
      throw new Error(`Invalid history for ${id}`);
  }
  return result;
}

export function checkAppendOnly(previous, current) {
  for (const [id, entry] of Object.entries(previous)) {
    for (const [kind, items] of Object.entries(entry)) {
      if (!items.every((item, index) => current[id]?.[kind]?.[index] === item))
        throw new Error(`${id}.${kind} must retain its immutable prefix`);
    }
  }
}

export function checkBoundary(path, source, paths) {
  const code = uncomment(source);
  if (/\b(?:require\s*\(|import\s*\(|import\s+\w+\s*=)/.test(code))
    throw new Error(`${path}: dynamic imports and require are forbidden`);
  for (const match of code.matchAll(
    /\b(import|export)\b\s*([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    const [, , binding, target] = match;
    if (target === 'zod' || target === 'zod/v4/core') continue;
    if (
      target === '@/local-data' &&
      /^type\s*\{\s*(?:(?:JsonMigration|SqliteMigration)\s*,?\s*)+\}$/.test(
        binding.trim(),
      )
    )
      continue;
    if (target.startsWith('./')) {
      const dependency = `${posix.normalize(posix.join(posix.dirname(path), target))}.ts`;
      if (
        dependency.startsWith(HISTORY) &&
        paths.has(dependency) &&
        dependency !== REGISTRY &&
        dependency !== `${HISTORY}index.ts`
      )
        continue;
    }
    throw new Error(`${path}: mutable or unsupported dependency ${target}`);
  }
  if (/\bimport\s*['"]/.test(code))
    throw new Error(`${path}: side-effect imports are forbidden`);
}

export function checkGraph(registry, read) {
  for (const [id, entry] of Object.entries(registry)) {
    for (const [index, identity] of entry.migrations.entries()) {
      const [path, symbol] = identity.split('#');
      const code = read(path);
      const declaration = code.match(
        new RegExp(
          `export const ${symbol}\\s*:\\s*(?:JsonMigration|SqliteMigration)\\s*=\\s*\\{\\s*from:\\s*(\\d+),\\s*to:\\s*(\\d+),`,
        ),
      );
      if (
        !declaration ||
        Number(declaration[1]) !== index + 1 ||
        Number(declaration[2]) !== index + 2
      )
        throw new Error(
          `${id}: missing, replaced or non-contiguous migration ${symbol}`,
        );
    }
    if (entry.versions) {
      if (entry.versions.length !== entry.migrations.length + 1)
        throw new Error(`${id}: version/migration count mismatch`);
      for (const [index, identity] of entry.versions.entries()) {
        const [path, symbol] = identity.split('#');
        const declaration = read(path).match(
          new RegExp(
            `export const ${symbol}\\s*=\\s*\\{\\s*version:\\s*(\\d+)`,
          ),
        );
        if (!declaration || Number(declaration[1]) !== index + 1)
          throw new Error(`${id}: non-contiguous historical schemas`);
      }
    }
  }
}

export function validateHistory(previous, current) {
  for (const [path, contents] of previous) {
    if (path !== REGISTRY && current.get(path) !== contents)
      throw new Error(`Immutable history changed, deleted or renamed: ${path}`);
  }
  const paths = new Set(current.keys());
  for (const [path, source] of current) {
    if (
      path.startsWith(HISTORY) &&
      path.endsWith('.ts') &&
      path !== `${HISTORY}index.ts`
    )
      checkBoundary(path, source, paths);
  }
  const registry = parseRegistry(current.get(REGISTRY) ?? '');
  if (previous.has(REGISTRY))
    checkAppendOnly(parseRegistry(previous.get(REGISTRY)), registry);
  checkGraph(registry, (path) => {
    if (!current.has(path))
      throw new Error(`Missing historical module ${path}`);
    return current.get(path);
  });
  return registry;
}

export function run(base) {
  if (!base || base.startsWith('-'))
    throw new Error(
      'Usage: node scripts/check-local-data-history.mjs <trusted-base-sha-or-ref>',
    );
  const sha = git('rev-parse', '--verify', `${base}^{commit}`)
    .toString()
    .trim();
  const protectedPath = (path) =>
    path.startsWith(HISTORY) || path.startsWith(FIXTURES);
  const baselinePaths = git('ls-tree', '-r', '--name-only', '-z', sha)
    .toString()
    .split('\0')
    .filter(protectedPath);
  const paths = [
    ...new Set(
      git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
        .toString()
        .split('\0')
        .filter(protectedPath),
    ),
  ];
  const previous = new Map(
    baselinePaths.map((path) => [
      path,
      git('show', `${sha}:${path}`).toString(),
    ]),
  );
  const current = new Map(
    paths.flatMap((path) => {
      try {
        return [[path, readFileSync(resolve(root, path), 'utf8')]];
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    }),
  );
  const registry = validateHistory(previous, current);
  console.log(
    `Local-data history verified against ${sha}: ${Object.keys(registry).length} stores${previous.size ? '' : ' (initial extraction; no historical baseline yet)'}.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    run(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

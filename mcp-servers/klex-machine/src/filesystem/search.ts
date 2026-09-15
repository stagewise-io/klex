import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import fg from 'fast-glob';
import createIgnore from 'ignore';
import safeRegex from 'safe-regex2';

import type { MachinePathResolver } from './paths.js';

export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_SEARCH_LIMIT = 1000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_CANDIDATES = 100_000;

export interface GlobResult {
  matches: string[];
  truncated: boolean;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  filesSearched: number;
  truncated: boolean;
}

export class SearchService {
  constructor(private readonly paths: MachinePathResolver) {}

  async glob(options: {
    patterns: string[];
    cwd?: string;
    exclude?: string[];
    hidden?: boolean;
    gitignore?: boolean;
    limit?: number;
  }): Promise<GlobResult> {
    if (options.patterns.length === 0)
      throw new Error('At least one pattern is required');
    const cwd = this.paths.resolve(options.cwd ?? '.');
    const limit = validateLimit(options.limit);
    const { entries, truncated: candidatesTruncated } = await enumerate(
      options.patterns,
      {
        absolute: true,
        cwd,
        dot: options.hidden ?? false,
        followSymbolicLinks: false,
        ignore: options.exclude ?? [],
        markDirectories: false,
        onlyFiles: false,
        unique: true,
      },
    );
    const ignored = options.gitignore === false ? null : await loadIgnore(cwd);
    const sorted = entries
      .map((entry) => resolve(entry))
      .filter((entry) => !ignored?.ignores(toRelative(cwd, entry)))
      .sort((left, right) => left.localeCompare(right));
    return {
      matches: sorted.slice(0, limit),
      truncated: candidatesTruncated || sorted.length > limit,
    };
  }

  async grep(options: {
    pattern: string;
    cwd?: string;
    include?: string[];
    exclude?: string[];
    caseSensitive?: boolean;
    hidden?: boolean;
    gitignore?: boolean;
    context?: number;
    limit?: number;
  }): Promise<GrepResult> {
    const cwd = this.paths.resolve(options.cwd ?? '.');
    const limit = validateLimit(options.limit);
    const context = options.context ?? 0;
    if (!Number.isInteger(context) || context < 0 || context > 20) {
      throw new Error('context must be an integer from 0 to 20');
    }
    if (!safeRegex(options.pattern)) {
      throw new Error('pattern is too complex for safe evaluation');
    }
    const flags = options.caseSensitive === false ? 'i' : '';
    const expression = new RegExp(options.pattern, flags);
    const { entries: candidates, truncated: candidatesTruncated } =
      await enumerate(options.include ?? ['**/*'], {
        absolute: true,
        cwd,
        dot: options.hidden ?? false,
        followSymbolicLinks: false,
        ignore: options.exclude ?? [],
        onlyFiles: true,
        unique: true,
      });
    const ignored = options.gitignore === false ? null : await loadIgnore(cwd);
    const files = candidates
      .map((entry) => resolve(entry))
      .filter((entry) => !ignored?.ignores(toRelative(cwd, entry)))
      .sort((left, right) => left.localeCompare(right));

    const matches: GrepMatch[] = [];
    let filesSearched = 0;
    let truncated = candidatesTruncated;
    for (const path of files) {
      const metadata = await stat(path).catch(() => null);
      if (!metadata?.isFile() || metadata.size > MAX_SEARCH_FILE_BYTES)
        continue;
      const bytes = await readFile(path).catch(() => null);
      if (!bytes || bytes.includes(0)) continue;
      filesSearched += 1;
      const lines = bytes.toString('utf8').split(/\r?\n/);
      for (const [index, text] of lines.entries()) {
        expression.lastIndex = 0;
        if (!expression.test(text)) continue;
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({
          path,
          line: index + 1,
          text,
          before: lines.slice(Math.max(0, index - context), index),
          after: lines.slice(index + 1, index + context + 1),
        });
      }
      if (truncated && matches.length >= limit) break;
    }
    return { matches, filesSearched, truncated };
  }
}

function validateLimit(input: number | undefined): number {
  const limit = input ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`);
  }
  return limit;
}

async function loadIgnore(
  cwd: string,
): Promise<ReturnType<typeof createIgnore> | null> {
  const { entries } = await enumerate(['**/.gitignore'], {
    absolute: true,
    cwd,
    dot: true,
    followSymbolicLinks: false,
    onlyFiles: true,
    unique: true,
  });
  if (entries.length === 0) return null;
  const ignored = createIgnore();
  for (const path of entries.sort()) {
    const source = await readFile(path, 'utf8').catch(() => null);
    if (source === null) continue;
    const base = toRelative(cwd, dirname(path));
    ignored.add(
      source
        .split(/\r?\n/)
        .flatMap((pattern) => rebaseIgnorePatterns(base, pattern)),
    );
  }
  return ignored;
}

async function enumerate(
  patterns: string[],
  options: Parameters<typeof fg.stream>[1],
): Promise<{ entries: string[]; truncated: boolean }> {
  const stream = fg.stream(patterns, options);
  const entries: string[] = [];
  for await (const entry of stream) {
    if (entries.length >= MAX_SEARCH_CANDIDATES) {
      return { entries, truncated: true };
    }
    entries.push(String(entry));
  }
  return { entries, truncated: false };
}

function rebaseIgnorePatterns(base: string, input: string): string[] {
  if (!base || !input || input.startsWith('#')) return [input];
  const negated = input.startsWith('!');
  const pattern = (negated ? input.slice(1) : input).replace(/^\//, '');
  const prefix = negated ? '!' : '';
  const rebased = `${prefix}${base}/${pattern}`;
  return pattern.includes('/')
    ? [rebased]
    : [rebased, `${prefix}${base}/**/${pattern}`];
}

function toRelative(cwd: string, path: string): string {
  return relative(cwd, path).split(sep).join('/');
}

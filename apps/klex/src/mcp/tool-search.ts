import {
  type JsonObject,
  ToolGatewayError,
  type ToolPage,
  type ToolSummary,
} from '@/tool-provider';

import type { RegisteredMcpNamespace } from './registry';

const normalize = (text: string) =>
  text.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
const words = (text: string): string[] =>
  normalize(
    text
      .normalize('NFC')
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
      .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
      .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, '$1$3 $2$4'),
  )
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean);

interface Query {
  key: string;
  alternatives: string[][];
  literals: string[];
}
function queryOf(text: string): Query {
  if (Buffer.byteLength(text) > 512)
    throw new ToolGatewayError(
      'invalid-query',
      'Use at most 512 UTF-8 bytes, 32 unique terms and 8 alternatives.',
    );
  const phrases = text.split('|');
  const alternatives = phrases.map((phrase) => {
    if (phrase.includes('*') || phrase.includes('?')) {
      const terms = normalize(phrase).split(' ').filter(Boolean);
      if (terms.some((term) => term.length > 128))
        throw new ToolGatewayError(
          'invalid-query',
          'Glob terms must be at most 128 characters.',
        );
      return [...new Set(terms)];
    }
    return [...new Set(words(phrase))].sort();
  });
  if (
    phrases.length > 8 ||
    new Set(alternatives.flat()).size > 32 ||
    (phrases.length > 1 && phrases.some((phrase) => !phrase.trim()))
  )
    throw new ToolGatewayError(
      'invalid-query',
      'Use at most 8 nonempty alternatives and 32 unique terms.',
    );
  const literals = phrases.map(normalize);
  // Preserve punctuation-only literal queries instead of browsing everything.
  alternatives.forEach((terms, index) => {
    if (!terms.length && literals[index]) terms.push(literals[index]!);
  });
  return {
    key: JSON.stringify([alternatives, literals]),
    alternatives,
    literals,
  };
}

function singular(term: string): string {
  if (!/^[a-z]{4,}$/u.test(term)) return term;
  if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes|sses)$/u.test(term)) return term.slice(0, -2);
  if (term.endsWith('s') && !/(ss|us|is)$/u.test(term))
    return term.slice(0, -1);
  return term;
}

/** Bounded edit distance, at most two edits; constant-sized token inputs. */
function closeWord(a: string, b: string): boolean {
  const limit = a.length >= 8 ? 2 : a.length >= 4 ? 1 : 0;
  if (
    !limit ||
    a.length > 64 ||
    b.length > 64 ||
    Math.abs(a.length - b.length) > limit
  )
    return false;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1]! + 1,
        row[j]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    if (Math.min(...next) > limit) return false;
    row = next;
  }
  return row[b.length]! <= limit;
}

/** Greedy wildcard matcher; bounded by query/catalog metadata limits, no regex. */
function glob(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let retry = 0;
  while (t < text.length) {
    if (pattern[p] === '?' || pattern[p] === text[t]) {
      p++;
      t++;
    } else if (pattern[p] === '*') {
      star = p++;
      retry = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++retry;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

interface Indexed {
  name: string;
  fields: string[];
  nameWords: string[];
  tokens: string[];
  joined: string;
  ordinal: number;
}
interface Catalog {
  source: RegisteredMcpNamespace;
  entries: Indexed[];
  queries: Map<string, { entry: Indexed; tier: number }[]>;
  summaries: Map<string, ToolSummary>;
}
interface Snapshot {
  catalog: Catalog;
  server: string;
  session: string | undefined;
  query: string;
  names: string[];
  offset: number;
  touched: number;
  bytes: number;
}

export interface ToolSearch {
  list(
    server: string,
    text: string,
    cursor: number,
    session: string | undefined,
    source: RegisteredMcpNamespace,
  ): ToolPage;
  dispatched(server: string, tool: string): void;
  invalidate(live: ReadonlyMap<string, RegisteredMcpNamespace>): void;
  release(session: string): void;
  clear(): void;
}
class ToolSearchModule implements ToolSearch {
  private readonly catalogs = new Map<string, Catalog>();
  private readonly snapshots = new Map<number, Snapshot>();
  private readonly usage: [string, string, number][] = [];
  private sequence = 0;
  private handle = 0;

  dispatched(server: string, tool: string): void {
    this.usage.push([server, tool, ++this.sequence]);
    if (this.usage.length > 1000) this.usage.shift();
  }
  release(session: string): void {
    for (const [handle, snapshot] of this.snapshots)
      if (snapshot.session === session) this.snapshots.delete(handle);
  }
  clear(): void {
    this.catalogs.clear();
    this.snapshots.clear();
    this.usage.length = 0;
  }
  invalidate(live: ReadonlyMap<string, RegisteredMcpNamespace>): void {
    for (const [server, catalog] of this.catalogs)
      if (live.get(server) !== catalog.source) this.catalogs.delete(server);
    for (const [handle, snapshot] of this.snapshots)
      if (live.get(snapshot.server) !== snapshot.catalog.source)
        this.snapshots.delete(handle);
  }
  list(
    server: string,
    text: string,
    cursor: number,
    session: string | undefined,
    source: RegisteredMcpNamespace,
  ): ToolPage {
    const query = queryOf(text);
    this.cleanup();
    if (!Number.isSafeInteger(cursor) || cursor < 0) this.badCursor();
    let snapshot: Snapshot;
    if (cursor) {
      const found = this.snapshots.get(cursor);
      if (
        !found ||
        found.server !== server ||
        found.session !== session ||
        found.query !== query.key ||
        found.catalog.source !== source
      )
        this.badCursor();
      snapshot = found;
    } else {
      let catalog = this.catalogs.get(server);
      if (!catalog || catalog.source !== source) {
        if (source.tools.size > 10_000)
          throw new ToolGatewayError(
            'catalog-too-large',
            'Search supports at most 10000 tools per server.',
          );
        let bytes = 0;
        const entries = [...source.tools.values()].map(({ tool }, ordinal) => {
          bytes +=
            Buffer.byteLength(tool.name) +
            Buffer.byteLength(tool.title ?? '') +
            Buffer.byteLength(tool.description ?? '');
          if (bytes > 5 * 1024 * 1024)
            throw new ToolGatewayError(
              'catalog-too-large',
              'Searchable metadata exceeds the 5 MiB catalog budget.',
            );
          const nameWords = words(tool.name);
          return {
            name: tool.name,
            fields: [tool.name, tool.title ?? '', tool.description ?? ''].map(
              normalize,
            ),
            nameWords,
            joined: nameWords.join(''),
            tokens: [
              ...new Set(
                words(
                  `${tool.name} ${tool.title ?? ''} ${tool.description ?? ''}`,
                ),
              ),
            ],
            ordinal,
          };
        });
        catalog = { source, entries, queries: new Map(), summaries: new Map() };
        this.catalogs.set(server, catalog);
      }
      let matches = catalog.queries.get(query.key);
      if (!matches) {
        // Bound fuzzy work: compare each distinct query term to each catalog token once.
        const vocabulary = [
          ...new Set(catalog.entries.flatMap((entry) => entry.tokens)),
        ];
        const fuzzy = new Map<string, Set<string>>();
        let comparisons = 0;
        for (const term of new Set(query.alternatives.flat())) {
          const candidates = new Set<string>();
          if (!term.includes('*') && !term.includes('?'))
            for (const token of vocabulary) {
              if (++comparisons > 250_000)
                throw new ToolGatewayError(
                  'invalid-query',
                  'Fuzzy search exceeds its work budget. Use a more specific glob or fewer alternatives.',
                );
              if (singular(term) === singular(token) || closeWord(term, token))
                candidates.add(token);
            }
          fuzzy.set(term, candidates);
        }
        matches = catalog.entries.flatMap((entry) => {
          const tiers = query.alternatives.map((terms, index) => {
            const literal = query.literals[index]!;
            if (!literal) return 0;
            if (entry.fields[0] === literal) return 0;
            const identifier = words(literal).join('');
            if (identifier && identifier === entry.joined) return 1;
            let tier = 1;
            for (const term of terms) {
              let current: number;
              if (term.includes('*') || term.includes('?'))
                current =
                  glob(term, entry.fields[0]!) ||
                  entry.nameWords.some((token) => glob(term, token))
                    ? 1
                    : entry.tokens.some((token) => glob(term, token))
                      ? 3
                      : Infinity;
              else if (
                entry.nameWords.includes(term) ||
                entry.nameWords.some((token) => token.startsWith(term))
              )
                current = 1;
              else if (
                entry.fields[0]!.includes(term) ||
                entry.joined.includes(term)
              )
                current = 2;
              else if (
                entry.fields.slice(1).some((field) => field.includes(term))
              )
                current = 3;
              else if (
                entry.nameWords.some((token) => fuzzy.get(term)?.has(token))
              )
                current = 4;
              else if (
                entry.tokens.some((token) => fuzzy.get(term)?.has(token))
              )
                current = 5;
              else return Infinity;
              tier = Math.max(tier, current);
            }
            return tier;
          });
          const tier = Math.min(...tiers);
          return Number.isFinite(tier) ? [{ entry, tier }] : [];
        });
        catalog.queries.set(query.key, matches);
        while (catalog.queries.size > 16)
          catalog.queries.delete(catalog.queries.keys().next().value!);
      }
      const usage = new Map<string, { count: number; recent: number }>();
      for (const [usedServer, name, recent] of this.usage)
        if (usedServer === server)
          usage.set(name, { count: (usage.get(name)?.count ?? 0) + 1, recent });
      const names = [...matches]
        .sort(
          (a, b) =>
            a.tier - b.tier ||
            (usage.get(b.entry.name)?.count ?? 0) -
              (usage.get(a.entry.name)?.count ?? 0) ||
            (usage.get(b.entry.name)?.recent ?? 0) -
              (usage.get(a.entry.name)?.recent ?? 0) ||
            a.entry.ordinal - b.entry.ordinal,
        )
        .map(({ entry }) => entry.name);
      snapshot = {
        catalog,
        names,
        server,
        session,
        query: query.key,
        offset: 0,
        touched: Date.now(),
        bytes: Buffer.byteLength(JSON.stringify(names)),
      };
      if (snapshot.bytes > 1024 * 1024)
        throw new ToolGatewayError(
          'catalog-too-large',
          'Search snapshot exceeds 1 MiB. Narrow the query.',
        );
    }
    const items: ToolSummary[] = [];
    let offset = snapshot.offset;
    for (; offset < snapshot.names.length && items.length < 10; offset++) {
      const name = snapshot.names[offset]!;
      let item = snapshot.catalog.summaries.get(name);
      if (!item) {
        const tool = source.tools.get(name)!.tool;
        item = [
          name,
          Array.from(tool.description ?? '')
            .slice(0, 160)
            .join(''),
          summarize(tool.inputSchema as JsonObject),
          true,
        ];
        snapshot.catalog.summaries.set(name, item);
        while (snapshot.catalog.summaries.size > 128)
          snapshot.catalog.summaries.delete(
            snapshot.catalog.summaries.keys().next().value!,
          );
      }
      const size = Buffer.byteLength(JSON.stringify(item));
      if (size > 8192)
        throw new ToolGatewayError(
          'catalog-too-large',
          'An exact tool identity exceeds the 8 KiB discovery item budget.',
        );
      if (Buffer.byteLength(JSON.stringify(items)) + size > 24 * 1024) break;
      items.push(item);
    }
    let nextCursor: number | null = null;
    if (offset < snapshot.names.length) {
      if (this.handle >= Number.MAX_SAFE_INTEGER)
        throw new ToolGatewayError(
          'invalid-cursor',
          'Cursor space exhausted; restart the process.',
        );
      nextCursor = ++this.handle;
      this.snapshots.set(nextCursor, {
        ...snapshot,
        offset,
        touched: Date.now(),
      });
      this.cleanup();
    }
    return {
      mcpServer: server,
      format: 'tool-summary-v1',
      items,
      total: snapshot.names.length,
      nextCursor,
      ...(snapshot.names.length === 0
        ? {
            hint: 'Use fewer keywords, alternatives separated by |, or an empty query to browse.',
          }
        : {}),
    };
  }
  private badCursor(): never {
    throw new ToolGatewayError(
      'invalid-cursor',
      'Cursor is invalid, mismatched, expired or evicted. Restart with cursor 0.',
    );
  }
  private cleanup(): void {
    for (const [handle, snapshot] of this.snapshots)
      if (Date.now() - snapshot.touched > 5 * 60_000)
        this.snapshots.delete(handle);
    let bytes = [...this.snapshots.values()].reduce(
      (sum, snapshot) => sum + snapshot.bytes,
      0,
    );
    while (this.snapshots.size > 64 || bytes > 4 * 1024 * 1024) {
      const handle = this.snapshots.keys().next().value!;
      bytes -= this.snapshots.get(handle)!.bytes;
      this.snapshots.delete(handle);
    }
  }
}

/** Bounded, deliberately lossy object hints; complete schemas live in getToolInfo. */
function summarize(schema: JsonObject): JsonObject {
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  )
    return {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const summary: JsonObject = {};
  for (const [key, value] of Object.entries(properties).sort(
    ([a], [b]) => Number(required.includes(b)) - Number(required.includes(a)),
  )) {
    if (Object.keys(summary).length >= 12) break;
    const field =
      value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const hint = {
      type: field.type ?? 'complex',
      required: required.includes(key),
      ...(Array.isArray(field.enum) && field.enum.length <= 6
        ? { enum: field.enum }
        : {}),
    };
    if (
      Buffer.byteLength(JSON.stringify([key, hint])) > 512 ||
      Buffer.byteLength(JSON.stringify(summary)) > 1536
    )
      continue;
    Object.defineProperty(summary, key, { value: hint, enumerable: true });
  }
  return summary;
}

export function createToolSearch(): ToolSearch {
  return new ToolSearchModule();
}

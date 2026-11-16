/**
 * Section body format: one fact per top-level bullet with inline citations,
 * superseded versions as `was:` sub-bullets (newest first).
 *
 * ```md
 * - Wants one PR per issue [2026-10-16 · slack](history:abc)
 *   - was: Wants combined PRs [2026-10-01 · slack](history:def)
 * ```
 */
export interface FactSource {
  label: string;
  id: string;
}
export interface FactVersion {
  text: string;
  sources: FactSource[];
}
export interface Fact extends FactVersion {
  /** Superseded versions, newest first. */
  history: FactVersion[];
}

export const MAX_FACT_SOURCES = 6;
export const MAX_FACT_HISTORY = 3;
export const MAX_FACT_LENGTH = 1_000;

const HISTORY_PREFIX = '  - was: ';
const trailingCitation = /\s*\[([^\]\n]*)\]\(history:([A-Za-z0-9_-]+)\)$/;
const anyCitation = /\[([^\]\n]*)\]\(history:([A-Za-z0-9_-]+)\)/g;

/** Normalizes model or legacy text into one valid fact line. */
export function factText(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim();
  if (!value) throw new Error('Fact text must not be empty');
  if (value.length > MAX_FACT_LENGTH)
    throw new Error(`Fact exceeds ${MAX_FACT_LENGTH} characters`);
  if (/history:|^#{1,6}\s/.test(value))
    throw new Error('Citations and headings are tool-managed');
  return value;
}

/** Deduplicates by message ID, keeping the newest occurrences. */
export function capSources(sources: readonly FactSource[]): FactSource[] {
  const byId = new Map<string, FactSource>();
  for (const source of sources) {
    byId.delete(source.id);
    byId.set(source.id, source);
  }
  return [...byId.values()].slice(-MAX_FACT_SOURCES);
}

function splitCitations(line: string): FactVersion {
  const sources: FactSource[] = [];
  let rest = line;
  for (
    let match = trailingCitation.exec(rest);
    match;
    match = trailingCitation.exec(rest)
  ) {
    sources.unshift({ label: match[1] ?? '', id: match[2] ?? '' });
    rest = rest.slice(0, match.index);
  }
  return { text: factText(rest), sources };
}

function extractCitations(text: string): FactVersion & { raw: string } {
  const sources: FactSource[] = [];
  const raw = text.replace(anyCitation, (_, label: string, id: string) => {
    sources.push({ label, id });
    return '';
  });
  return { raw, text: raw, sources };
}

// Paragraph prose with trailing `Sources:` lines, as written before facts.
function parseLegacy(content: string): Fact[] {
  const facts: Fact[] = [];
  let paragraphs: string[][] = [];
  let current: string[] = [];
  const closeParagraph = () => {
    if (current.length) paragraphs.push(current);
    current = [];
  };
  const flush = (groupSources: FactSource[]) => {
    closeParagraph();
    for (const lines of paragraphs) {
      const texts = lines.every((line) => line.startsWith('- '))
        ? lines.map((line) => line.slice(2))
        : [lines.join(' ')];
      for (const text of texts) {
        const inline = extractCitations(text);
        facts.push({
          text: factText(inline.raw),
          sources: capSources([...groupSources, ...inline.sources]),
          history: [],
        });
      }
    }
    paragraphs = [];
  };
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Sources:'))
      flush(extractCitations(trimmed).sources);
    else if (!trimmed) closeParagraph();
    else current.push(trimmed);
  }
  flush([]);
  return facts;
}

export function parseFacts(content: string): Fact[] {
  const lines = content.split('\n').filter((line) => line.trim());
  if (lines.some((line) => /^##\s/.test(line)))
    throw new Error('Section content must not contain level-two headings');
  const structured =
    lines.length > 0 &&
    lines[0]?.startsWith('- ') &&
    lines.every(
      (line) => line.startsWith('- ') || line.startsWith(HISTORY_PREFIX),
    );
  if (!structured) return parseLegacy(content);
  const facts: Fact[] = [];
  for (const line of lines) {
    if (line.startsWith(HISTORY_PREFIX))
      facts
        .at(-1)
        ?.history.push(splitCitations(line.slice(HISTORY_PREFIX.length)));
    else facts.push({ ...splitCitations(line.slice(2)), history: [] });
  }
  return facts;
}

function formatVersion(prefix: string, version: FactVersion): string {
  const citations = capSources(version.sources).map(({ label, id }) => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid source ID');
    return ` [${label.replace(/[[\]\n]/g, '')}](history:${id})`;
  });
  return `${prefix}${factText(version.text)}${citations.join('')}`;
}

export function formatFacts(facts: readonly Fact[]): string {
  return facts
    .map((fact) =>
      [
        formatVersion('- ', fact),
        ...fact.history
          .slice(0, MAX_FACT_HISTORY)
          .map((version) => formatVersion(HISTORY_PREFIX, version)),
      ].join('\n'),
    )
    .join('\n');
}

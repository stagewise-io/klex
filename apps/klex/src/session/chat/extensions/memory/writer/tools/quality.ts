// Output checks for the memory writer. Every message says what is wrong, what
// to do and shows a corrected example: small models repair from concrete
// feedback far more reliably than from prompt rules.

export const MAX_WRITER_FACT = 160;

const PROGRESS =
  /\b(tests? (?:pass(?:ed)?|fail(?:ed)?)|merged|in progress|todo|wip|this run|will (?:be|do|add|fix|review|check))\b/i;
const RUN_SPECIFIC =
  /\b(this run|this time|today|yesterday|just now)\b|\b\d{4}-\d{2}-\d{2}\b/i;

const lower = (value: string) => value.trim().toLowerCase();

/**
 * Subject words a fact must not start with: the title (also without its
 * disambiguating qualifier) and a person's first name.
 */
function subjects(title: string, person: boolean): string[] {
  const plain = title.replace(/\s*\([^()]*\)\s*$/, '').trim() || title.trim();
  const words = plain.split(/\s+/);
  const first = words[0] ?? '';
  return [
    ...new Set([lower(title), lower(plain)]),
    ...(person && words.length > 1 && first.length >= 3 ? [lower(first)] : []),
  ];
}

export function checkFact(text: string, title: string, person: boolean): void {
  const value = text.trim();
  const start = lower(value);
  const subject = subjects(title, person).find(
    (candidate) =>
      start === candidate ||
      (start.startsWith(candidate) &&
        /[\s:,'’]/.test(value[candidate.length] ?? '')),
  );
  if (subject)
    throw new Error(
      `Drop the subject; facts are already about "${title}". e.g. "Prefers short replies", not "${title} prefers short replies"`,
    );
  if (value.length > MAX_WRITER_FACT)
    throw new Error(
      `Fact is ${value.length} chars, max ${MAX_WRITER_FACT}. Shorten or split into two facts`,
    );
  const progress = PROGRESS.exec(value)?.[0];
  if (progress)
    throw new Error(
      `"${progress}" is progress or status, not a lasting fact. Keep only decisions, reasons, constraints, pitfalls. e.g. "Chose muted color: errors looked like crashes"`,
    );
}

/** Whole-token match: a truncated ID must not pass as a prefix of the real one. */
function containsToken(text: string, value: string): boolean {
  for (
    let at = text.indexOf(value);
    at !== -1;
    at = text.indexOf(value, at + 1)
  ) {
    const before = text[at - 1] ?? '';
    const after = text[at + value.length] ?? '';
    if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) return true;
  }
  return false;
}

/** Values that must have been copied from the activities, never typed from memory. */
export function checkCopied(
  values: readonly string[],
  evidence: string,
  what: string,
): void {
  for (const value of values) {
    if (value.length < 4 || containsToken(evidence, value)) continue;
    const shown = value.length > 24 ? `${value.slice(0, 20)}…` : value;
    throw new Error(
      `${what} "${shown}" not found in the activities. Copy it exactly from the event or message; never shorten or guess IDs`,
    );
  }
}

/** Identity and literal matcher values of entity or skill fields. */
export function copiedValues(fields: {
  linkedIdentities?: readonly { match: Record<string, string> }[];
  loadOn?: readonly (
    | { type: 'contentPattern'; pattern: string }
    | {
        type: 'eventDataPattern';
        conditions: readonly { match: string; value: string }[];
      }
    | {
        type: 'toolCallPattern';
        arguments: readonly { match: string; value: string }[];
      }
  )[];
}): { identities: string[]; matchers: string[] } {
  return {
    identities: (fields.linkedIdentities ?? []).flatMap((identity) =>
      Object.values(identity.match),
    ),
    matchers: (fields.loadOn ?? []).flatMap((matcher) =>
      matcher.type === 'contentPattern'
        ? [matcher.pattern]
        : (matcher.type === 'toolCallPattern'
            ? matcher.arguments
            : matcher.conditions
          )
            .filter((condition) => condition.match === 'exact')
            .map((condition) => condition.value),
    ),
  };
}

export function checkSkillItem(text: string, field: string): void {
  const hit = RUN_SPECIFIC.exec(text)?.[0];
  if (hit)
    throw new Error(
      `${field}: "${hit}" ties it to one run. Generalize. e.g. "Full disk blocks installs; check free space first"`,
    );
}

// Whole words only: hyphenated compounds such as `no-op` are not negations.
const NEGATION =
  /(?<![\w'’-])(not|never|no|cannot|(?:can|won|don|doesn|isn|aren|shouldn)['’]?t|except|unless|instead of|avoid)(?![\w'’-])/i;

/** The description says when a skill applies; exclusions confuse loaders. */
export function checkSkillWhen(text: string): void {
  const hit = NEGATION.exec(text)?.[0];
  if (hit)
    throw new Error(
      `when: "${hit}" is a negation. Say only when it applies and what for, in short positive sentences. e.g. "Opening a GitHub PR from a sandbox. Gets branch, push and PR call right."`,
    );
}

export interface StructuredSkill {
  steps: string[];
  pitfalls: string[];
  verify: string;
}

export function renderSkillBody(skill: StructuredSkill): string {
  return [
    '## Steps',
    ...skill.steps.map((step, index) => `${index + 1}. ${step}`),
    ...(skill.pitfalls.length
      ? ['', '## Pitfalls', ...skill.pitfalls.map((pitfall) => `- ${pitfall}`)]
      : []),
    ...(skill.verify ? ['', '## Verify', skill.verify] : []),
  ].join('\n');
}

/** Inverse of {@link renderSkillBody}; null for free-form legacy bodies. */
export function parseSkillBody(body: string): StructuredSkill | null {
  const match =
    /^## Steps\n((?:\d+\. .+\n?)+)(?:\n## Pitfalls\n((?:- .+\n?)+))?(?:\n## Verify\n(.+)\n?)?$/.exec(
      body.trim(),
    );
  if (!match) return null;
  const lines = (block = '', marker: RegExp) =>
    block
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(marker, ''));
  return {
    steps: lines(match[1], /^\d+\. /),
    pitfalls: lines(match[2], /^- /),
    verify: match[3] ?? '',
  };
}

export function checkSkill(skill: StructuredSkill): void {
  skill.steps.forEach((step) => {
    checkSkillItem(step, 'step');
  });
  skill.pitfalls.forEach((pitfall) => {
    checkSkillItem(pitfall, 'pitfall');
  });
  if (skill.verify) {
    checkSkillItem(skill.verify, 'verify');
    if (skill.steps.some((step) => lower(step) === lower(skill.verify)))
      throw new Error(
        'verify repeats a step. Give the one concrete check of success, or leave verify empty',
      );
  }
}

const nameWords = (name: string) =>
  new Set(name.split('-').filter((word) => word.length >= 3));

/** Learned skills a new one probably duplicates: shared trigger tool or server, or two name words. */
export function similarSkills(
  name: string,
  loadOn: readonly {
    type: string;
    mcpServer?: string;
    server?: string;
    toolName?: string;
  }[],
  existing: readonly {
    id: string;
    name: string;
    metadata: Record<string, unknown>;
  }[],
): string[] {
  // Content patterns have no tool or server; they must not all look alike.
  const trigger = (matcher: (typeof loadOn)[number]) =>
    matcher.toolName ?? matcher.mcpServer ?? matcher.server;
  const triggers = new Set(loadOn.map(trigger).filter(Boolean));
  const words = nameWords(name);
  return existing
    .filter((skill) => {
      const other = Array.isArray(skill.metadata.loadOn)
        ? (skill.metadata.loadOn as typeof loadOn)
        : [];
      const sharedTrigger = other.some((matcher) => {
        const key = trigger(matcher);
        return key !== undefined && triggers.has(key);
      });
      const shared = [...nameWords(skill.name)].filter((word) =>
        words.has(word),
      ).length;
      return sharedTrigger || shared >= 2;
    })
    .map((skill) => skill.id);
}

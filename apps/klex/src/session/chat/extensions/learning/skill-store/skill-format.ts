import {
  MAX_BODY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  SKILL_NAME_PATTERN,
} from '../learning-config';

export interface LearnedSkill {
  name: string;
  description: string;
  body: string;
}

export function isValidSkillName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && SKILL_NAME_PATTERN.test(name);
}

/** Null when valid, otherwise the reason. */
export function validateSkill(skill: LearnedSkill): string | null {
  if (!isValidSkillName(skill.name)) return `invalid name "${skill.name}"`;
  const description = skill.description.trim();
  if (!description) return 'empty description';
  if (description.includes('\n')) return 'multi-line description';
  if (description.length > MAX_DESCRIPTION_LENGTH)
    return 'description too long';
  if (!skill.body.trim()) return 'empty body';
  if (skill.body.length > MAX_BODY_LENGTH) return 'body too long';
  return null;
}

/**
 * Serializes an Agent Skills `SKILL.md`. The description is a JSON string,
 * which is valid YAML double-quoted syntax, so no YAML library is needed.
 */
export function serializeSkill(skill: LearnedSkill): string {
  return [
    '---',
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description.trim())}`,
    '---',
    '',
    `${skill.body.trim()}\n`,
  ].join('\n');
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parses a `SKILL.md` with single-line `name` and `description`. */
export function parseSkill(content: string): LearnedSkill | null {
  const match = FRONTMATTER.exec(content);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    const value = parseScalar(raw);
    if (value === null) return null;
    fields.set(key, value);
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) return null;
  return { name, description, body: (match[2] ?? '').trim() };
}

function parseScalar(raw: string): string | null {
  if (raw.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

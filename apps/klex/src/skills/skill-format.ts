import {
  MAX_BODY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  SKILL_NAME_PATTERN,
} from './skills-config';

/** Content of one Agent Skills `SKILL.md`. */
export interface SkillDocument {
  name: string;
  description: string;
  body: string;
}

export function isValidSkillName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && SKILL_NAME_PATTERN.test(name);
}

/** Namespaces use the same slug syntax as skill names. */
export function isValidSkillNamespace(namespace: string): boolean {
  return isValidSkillName(namespace);
}

/** Qualified skill id: `namespace/name`. */
export function formatSkillId(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

/** Null unless `id` is a valid `namespace/name`. */
export function parseSkillId(
  id: string,
): { namespace: string; name: string } | null {
  const separator = id.indexOf('/');
  if (separator <= 0) return null;
  const namespace = id.slice(0, separator);
  const name = id.slice(separator + 1);
  if (!isValidSkillNamespace(namespace) || !isValidSkillName(name)) return null;
  return { namespace, name };
}

/** Null when valid, otherwise the reason. */
export function validateSkill(skill: SkillDocument): string | null {
  if (!isValidSkillName(skill.name)) return `invalid name "${skill.name}"`;
  const description = skill.description.trim();
  if (!description) return 'empty description';
  if (/[\n\r\u0085\u2028\u2029]/u.test(description))
    return 'multi-line description';
  if (description.length > MAX_DESCRIPTION_LENGTH)
    return 'description too long';
  if (!skill.body.trim()) return 'empty body';
  if (skill.body.length > MAX_BODY_LENGTH) return 'body too long';
  return null;
}

/**
 * Serializes an Agent Skills `SKILL.md`. Name and description are JSON
 * strings, which is valid YAML double-quoted syntax, so no YAML library is
 * needed and names like `true` or `123` stay strings.
 */
export function serializeSkill(skill: SkillDocument): string {
  return [
    '---',
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description.trim())}`,
    '---',
    '',
    `${skill.body.trim()}\n`,
  ].join('\n');
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parses a `SKILL.md` with single-line `name` and `description`. */
export function parseSkill(content: string): SkillDocument | null {
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

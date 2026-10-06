import { LINES_FORMAT_PROMPT } from '@/session/chat/utils/history-view';

import consolidationPrompt from './consolidation-prompt.md';
import extractionPrompt from './extraction-prompt.md';
import {
  MAX_BODY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_EPISODE_CHARACTERS,
  MAX_NAME_LENGTH,
  MAX_PROMPT_LIST_CHARACTERS,
  MAX_SKILLS,
  STALE_AFTER_MS,
} from './learning-config';
import type { LearnedSkill } from './skill-store';
import systemPromptPart from './system-prompt-part.md';

export interface PromptSkillUsage {
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
  readCount: number;
}

export interface PromptEpisode {
  id: string;
  startedAt: string;
  endedAt: string;
  text: string;
}

export interface BuiltPrompt {
  system: string;
  prompt: string;
}

const PLACEHOLDERS: Record<string, number> = {
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_BODY_LENGTH,
  MAX_SKILLS,
};

/** Fills `{{NAME}}` placeholders with the limits from `learning-config.ts`. */
export function fillPlaceholders(template: string): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) =>
    key in PLACEHOLDERS ? String(PLACEHOLDERS[key]) : match,
  );
}

/** Opening or closing prompt tags, tolerant of whitespace and attributes. */
const PROMPT_TAG = /<(\s*\/?\s*(?:skills|skill|episode)\b)/giu;

/** Defuses prompt tags so embedded content cannot close or forge a block. */
export function defuse(text: string): string {
  return text.replace(PROMPT_TAG, '\uFF1C$1');
}

function attribute(value: string): string {
  return value.replace(/[&"<>]/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function clipEpisodeText(text: string): string {
  if (text.length <= MAX_EPISODE_CHARACTERS) return text;
  const omitted = text.length - MAX_EPISODE_CHARACTERS;
  return `[… ${omitted} earlier characters omitted]\n${text.slice(-MAX_EPISODE_CHARACTERS)}`;
}

function renderSkills(
  skills: readonly LearnedSkill[],
  extraAttributes: (skill: LearnedSkill) => string = () => '',
): string {
  if (skills.length === 0) return '<skills>\n(none)\n</skills>';
  const entries = skills.map(
    (skill) =>
      `<skill name="${attribute(skill.name)}"${extraAttributes(skill)}>\n` +
      `description: ${defuse(skill.description)}\n\n${defuse(skill.body)}\n</skill>`,
  );
  return `<skills>\n${entries.join('\n')}\n</skills>`;
}

export function buildExtractionPrompt(input: {
  skills: readonly LearnedSkill[];
  episode: PromptEpisode;
}): BuiltPrompt {
  const { episode } = input;
  return {
    system: `${fillPlaceholders(extractionPrompt).trimEnd()}\n\n${LINES_FORMAT_PROMPT}`,
    prompt:
      `${renderSkills(input.skills)}\n\n` +
      `<episode id="${attribute(episode.id)}" started="${attribute(episode.startedAt)}" ended="${attribute(episode.endedAt)}">\n` +
      `${defuse(clipEpisodeText(episode.text))}\n</episode>`,
  };
}

export function isStale(
  usage: PromptSkillUsage | undefined,
  now: number,
): boolean {
  if (!usage) return false;
  const last = Date.parse(usage.lastReadAt ?? usage.createdAt);
  return Number.isFinite(last) && now - last >= STALE_AFTER_MS;
}

export function buildConsolidationPrompt(input: {
  skills: readonly LearnedSkill[];
  usage: Readonly<Record<string, PromptSkillUsage>>;
  now: number;
}): BuiltPrompt {
  const skills = renderSkills(input.skills, (skill) => {
    const usage = input.usage[skill.name];
    if (!usage) return '';
    const stale = isStale(usage, input.now) ? ' stale="true"' : '';
    const lastRead = usage.lastReadAt ?? 'never';
    return (
      ` readCount="${usage.readCount}" lastReadAt="${attribute(lastRead)}"` +
      ` createdAt="${attribute(usage.createdAt)}"${stale}`
    );
  });
  return {
    system: fillPlaceholders(consolidationPrompt).trimEnd(),
    prompt: skills,
  };
}

function recency(usage: PromptSkillUsage | undefined): number {
  if (!usage) return 0;
  const value = Date.parse(usage.lastReadAt ?? usage.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The main-session skill list: intro, then `- name: description`, most
 * recently used first, capped at `MAX_PROMPT_LIST_CHARACTERS`.
 */
export function renderSkillList(
  skills: readonly LearnedSkill[],
  usage: Readonly<Record<string, PromptSkillUsage>>,
): string {
  if (skills.length === 0) return '';
  const ordered = [...skills].sort(
    (left, right) =>
      recency(usage[right.name]) - recency(usage[left.name]) ||
      left.name.localeCompare(right.name),
  );
  const lines: string[] = [];
  let length = 0;
  for (const [index, skill] of ordered.entries()) {
    const line = `- ${skill.name}: ${skill.description.replace(/\s+/g, ' ')}`;
    if (length + line.length + 1 > MAX_PROMPT_LIST_CHARACTERS) {
      lines.push(`- … ${ordered.length - index} more (use readSkill by name)`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return `${systemPromptPart.trimEnd()}\n\n${lines.join('\n')}`;
}

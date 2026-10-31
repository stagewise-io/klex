import { LINES_FORMAT_PROMPT } from '@/session/chat/utils/history-view';
import type { Skill, SkillDocument } from '@/skills';

import consolidationPrompt from './consolidation-prompt.md';
import extractionPrompt from './extraction-prompt.md';
import {
  MAX_BODY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_EPISODE_CHARACTERS,
  MAX_NAME_LENGTH,
  MAX_SKILLS,
  STALE_AFTER_TURNS,
} from './learning-config';

/** Turn positions used for relevance; see `SkillRegistry.currentTurn`. */
export type SkillTurns = Pick<
  Skill,
  'createdTurn' | 'updatedTurn' | 'lastReadTurn'
>;

export interface PromptEpisode {
  id: string;
  startedAt: string;
  endedAt: string;
  text: string;
}

export interface PromptAgent {
  name: string;
  soul: string | null;
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

/** Expands {{UPPER_SNAKE_CASE}} placeholders once; inserted content is never re-templated. */
export function fillPlaceholders(
  template: string,
  agent?: PromptAgent,
): string {
  const values: Record<string, string | number> = { ...PLACEHOLDERS };
  if (agent) {
    values.NAME = defuse(agent.name);
    values.SOUL = defuse(agent.soul?.trim() ? agent.soul : 'No soul defined.');
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

/** Opening or closing prompt tags, tolerant of whitespace and attributes. */
const PROMPT_TAG = /<(\s*\/?\s*(?:skills|skill|episode|soul)\b)/giu;

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

function renderSkills<T extends SkillDocument>(
  skills: readonly T[],
  extraAttributes: (skill: T) => string = () => '',
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
  agent: PromptAgent;
  skills: readonly SkillDocument[];
  episode: PromptEpisode;
}): BuiltPrompt {
  const { episode } = input;
  return {
    system: `${fillPlaceholders(extractionPrompt, input.agent).trimEnd()}\n\n${LINES_FORMAT_PROMPT}`,
    prompt:
      `${renderSkills(input.skills)}\n\n` +
      `<episode id="${attribute(episode.id)}" started="${attribute(episode.startedAt)}" ended="${attribute(episode.endedAt)}">\n` +
      `${defuse(clipEpisodeText(episode.text))}\n</episode>`,
  };
}

/** Most recent turn a skill was created, changed, or read. */
export function lastActiveTurn(skill: SkillTurns): number {
  return Math.max(
    skill.createdTurn,
    skill.updatedTurn,
    skill.lastReadTurn ?? skill.createdTurn,
  );
}

export function isStale(skill: SkillTurns, currentTurn: number): boolean {
  return currentTurn - lastActiveTurn(skill) >= STALE_AFTER_TURNS;
}

/** Episode ids stored by learning in the skill's namespace metadata. */
export function sourceEpisodesOf(skill: Pick<Skill, 'metadata'>): string[] {
  const value = skill.metadata.sourceEpisodes;
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string')
    : [];
}

export function buildConsolidationPrompt(input: {
  agent: PromptAgent;
  skills: readonly Skill[];
  currentTurn: number;
}): BuiltPrompt {
  const skills = renderSkills(input.skills, (skill) => {
    const stale = isStale(skill, input.currentTurn) ? ' stale="true"' : '';
    const lastRead = skill.lastReadAt ?? 'never';
    return (
      ` readCount="${skill.readCount}" lastReadAt="${attribute(lastRead)}"` +
      ` createdAt="${attribute(skill.createdAt)}" sourceEpisodes="${attribute(sourceEpisodesOf(skill).join(','))}"${stale}`
    );
  });
  return {
    system: fillPlaceholders(consolidationPrompt, input.agent).trimEnd(),
    prompt: skills,
  };
}

import { createHash } from 'node:crypto';

import { isDataPartOf } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { parseSnapshot } from './types';

const escapeSkill = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const cell = (value: string) =>
  escapeSkill(value).replaceAll('|', '&#124;').replace(/\s+/gu, ' ');
interface Listed {
  name: string;
  description: string;
}
function table(skills: Listed[]): string {
  return [
    '| name | description |',
    '| --- | --- |',
    ...skills.map(
      (skill) => `| ${cell(skill.name)} | ${cell(skill.description)} |`,
    ),
  ].join('\n');
}
/** Historical immutable snapshots render once; checkpoint carry becomes the new base. */
export function materializeSkills(
  history: ExtendedUIMessage[],
): ExtendedUIMessage[] {
  let catalogue: Listed[] | undefined;
  const header = history[0];
  const checkpoint = header?.parts.some((part) =>
    isDataPartOf('context-summary', part),
  );
  const carried = checkpoint
    ? header?.parts.find((part) => isDataPartOf('activeSkills', part))
    : undefined;
  const window = (
    carried as unknown as { data?: { window?: string } } | undefined
  )?.data?.window;
  const seen = new Map<string, string>();
  const prefix: string[] = [];
  const output: ExtendedUIMessage[] = [];
  for (const message of history) {
    const blocks: string[] = [];
    const parts: ExtendedUIMessage['parts'] = [];
    for (const part of message.parts) {
      if (isDataPartOf('availableSkills', part)) {
        const skills = (part as unknown as { data: Listed[] }).data;
        if (
          !Array.isArray(skills) ||
          !skills.every(
            (skill) =>
              skill &&
              typeof skill.name === 'string' &&
              typeof skill.description === 'string',
          )
        )
          continue;
        if (catalogue === undefined)
          prefix.push(
            `<available-skills>\n${table(skills)}\n</available-skills>`,
          );
        else if (JSON.stringify(catalogue) !== JSON.stringify(skills)) {
          const removed = catalogue
            .filter(
              (previous) =>
                !skills.some((skill) => skill.name === previous.name),
            )
            .map((skill) => `Removed: ${cell(skill.name)}`);
          blocks.push(
            `<available-skills-change>\n${table(skills)}${removed.length ? `\n${removed.join('\n')}` : ''}\n</available-skills-change>`,
          );
        }
        catalogue = skills;
        continue;
      }
      if (isDataPartOf('activeSkills', part)) continue;
      if (!isDataPartOf('loadedMemories', part)) {
        parts.push(part);
        continue;
      }
      const remaining: Record<string, string> = {};
      const data = (part as unknown as { data: unknown }).data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      for (const [filename, value] of Object.entries(data)) {
        if (typeof value !== 'string') continue;
        const snapshot = parseSnapshot(value);
        if (
          !snapshot ||
          !['skill', 'skill-reference'].includes(snapshot.kind)
        ) {
          remaining[filename] = value;
          continue;
        }
        if (window && snapshot.window !== window) continue;
        const hash = createHash('sha256').update(value).digest('hex');
        if (seen.get(filename) === hash) continue;
        seen.set(filename, hash);
        const attrs = `name="${escapeSkill(snapshot.title)}"${snapshot.kind === 'skill-reference' ? ` reference="${escapeSkill(snapshot.section ?? '')}"` : ''}`;
        const tag = snapshot.kind;
        const references = snapshot.references?.length
          ? `\n\nReferences (loadSkill with reference): ${snapshot.references.join(', ')}`
          : '';
        const text = `<${tag} ${attrs}>\n${escapeSkill(snapshot.body)}${escapeSkill(references)}\n</${tag}>`;
        if (
          message === history[0] &&
          message.parts.some((item) => isDataPartOf('context-summary', item))
        )
          prefix.push(text);
        else blocks.push(text);
      }
      parts.push({ type: 'data-loadedMemories', data: remaining } as never);
    }
    if (parts.length) output.push({ ...message, parts });
    if (blocks.length)
      output.push({
        id: `${message.id}:skills`,
        role: 'user',
        parts: [{ type: 'text', text: blocks.join('\n\n') }],
      });
  }
  if (prefix.length)
    output.unshift({
      id: 'skill-context',
      role: 'user',
      parts: [{ type: 'text', text: prefix.join('\n\n') }],
    });
  return output;
}

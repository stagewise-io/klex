import { createHash } from 'node:crypto';

import { isDataPartOf } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { diff } from './render';
import { type MemorySnapshot, parseSnapshot } from './types';

const quote = (value: string) =>
  value
    .split(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/u)
    .map((line) => `¦${line}`)
    .join('\n');
const inline = (value: string) =>
  value.replace(/[\r\n\v\f\u0085\u2028\u2029]/gu, ' ');
const cell = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\s+/gu, ' ');
interface Listed {
  name: string;
  description: string;
}
function skillBody(snapshot: MemorySnapshot): string {
  return (
    snapshot.body +
    (snapshot.references?.length
      ? `\n\nReferences (loadSkill with reference): ${snapshot.references.join(', ')}`
      : '')
  );
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
  const snapshots = new Map<string, MemorySnapshot>();
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
          prefix.push(`available-skills\n${quote(table(skills))}`);
        else if (JSON.stringify(catalogue) !== JSON.stringify(skills)) {
          const previous = new Map(
            catalogue.map((skill) => [skill.name, skill.description]),
          );
          const added = skills.filter((skill) => !previous.has(skill.name));
          const changed = skills.filter(
            (skill) =>
              previous.has(skill.name) &&
              previous.get(skill.name) !== skill.description,
          );
          const removed = catalogue
            .filter(
              (previous) =>
                !skills.some((skill) => skill.name === previous.name),
            )
            .map((skill) => `Deleted: ${cell(skill.name)}`);
          if (added.length || changed.length || removed.length)
            blocks.push(
              `available-skills-change\n${quote(
                [
                  ...(added.length ? [`New:\n${table(added)}`] : []),
                  ...(changed.length ? [`Updated:\n${table(changed)}`] : []),
                  ...removed,
                ].join('\n'),
              )}`,
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
        const label = `${inline(snapshot.title)}${snapshot.kind === 'skill-reference' ? ` reference=${JSON.stringify(snapshot.section ?? '')}` : ''}`;
        const tag = snapshot.kind;
        const previous = snapshots.get(filename);
        snapshots.set(filename, snapshot);
        const current = skillBody(snapshot);
        const full = (replacement = false) =>
          [
            `${tag} ${label}${replacement ? ' replacement' : ''}`,
            ...(snapshot.description
              ? [`description\n${quote(snapshot.description)}`]
              : []),
            `content\n${quote(current)}`,
          ].join('\n');
        let text = full();
        if (snapshot.removed) {
          text = `${tag}-update ${label} deleted`;
        } else if (previous && !previous.removed) {
          const before = skillBody(previous);
          const metadata =
            previous.description !== snapshot.description
              ? `\nDescription changed: ${snapshot.description ?? '(removed)'}`
              : '';
          if (before === current && !metadata) continue;
          // Bound diff work, and use a full replacement when the patch is larger.
          const bounded =
            before.length + current.length <= 100_000 &&
            before.split('\n').length + current.split('\n').length <= 10_000;
          const patch =
            bounded && before !== current ? diff(before, current) : '';
          text =
            bounded &&
            (before === current ||
              patch.length + metadata.length < current.length)
              ? [
                  `${tag}-update ${label}`,
                  ...(patch ? [`patch\n${quote(patch)}`] : []),
                  ...(metadata ? [`metadata\n${quote(metadata.trim())}`] : []),
                ].join('\n')
              : full(true);
        }
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

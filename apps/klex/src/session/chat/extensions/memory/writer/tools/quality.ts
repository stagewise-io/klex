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

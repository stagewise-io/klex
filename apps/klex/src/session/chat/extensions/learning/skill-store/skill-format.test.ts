import { describe, expect, it } from 'vitest';

import {
  isValidSkillName,
  parseSkill,
  serializeSkill,
  validateSkill,
} from './skill-format';

describe('SKILL.md format', () => {
  it('round-trips quotes, colons, unicode, and markdown bodies', () => {
    const skill = {
      name: 'ask-before-contract-changes',
      description: 'Use when "core" contracts change: ask first — ünïcode ✓',
      body: '# Steps\n\n1. Ask.\n2. Wait for approval.\n\n---\nnot frontmatter',
    };
    const content = serializeSkill(skill);
    expect(
      content.startsWith('---\nname: "ask-before-contract-changes"\n'),
    ).toBe(true);
    expect(parseSkill(content)).toEqual(skill);
  });

  it('accepts plain and single-quoted values', () => {
    expect(
      parseSkill("---\nname: plain\ndescription: 'It''s plain'\n---\nBody"),
    ).toEqual({ name: 'plain', description: "It's plain", body: 'Body' });
    expect(parseSkill('---\nname: x\ndescription: just text\n---\n')).toEqual({
      name: 'x',
      description: 'just text',
      body: '',
    });
  });

  it('rejects malformed files', () => {
    expect(parseSkill('no frontmatter')).toBeNull();
    expect(parseSkill('---\nname: x\n---\nbody')).toBeNull();
    expect(parseSkill('---\nname: x\ndescription: "broken\n---\nb')).toBeNull();
  });

  it('validates names and lengths', () => {
    expect(isValidSkillName('a-b-1')).toBe(true);
    for (const name of ['A', 'a--b', '-a', 'a/b', '..', '', 'a'.repeat(65)]) {
      expect(isValidSkillName(name)).toBe(false);
    }
    const valid = { name: 'a', description: 'd', body: 'b' };
    expect(validateSkill(valid)).toBeNull();
    expect(validateSkill({ ...valid, description: 'x'.repeat(301) })).toMatch(
      /description/,
    );
    expect(validateSkill({ ...valid, description: 'a\nb' })).toMatch(
      /multi-line/,
    );
    expect(validateSkill({ ...valid, body: 'x'.repeat(4_001) })).toMatch(
      /body/,
    );
  });
});

import { describe, expect, it } from 'vitest';

import type { MemoryEntity } from './entities';
import { knownTags, renderKnownTags } from './tags';

const tagged = (...Tags: string[]) =>
  ({ frontmatter: { Tags } }) as unknown as MemoryEntity;

describe('known tags', () => {
  it('lists implied parents so nested tags render under their own parent', () => {
    const tags = knownTags([
      tagged('project/stagewise-io'),
      tagged('project/stagewise-io', 'a/b/c'),
    ]);
    expect(tags).toContainEqual({ tag: 'project', count: 0 });
    expect(tags).toContainEqual({ tag: 'project/stagewise-io', count: 2 });
    expect(tags).toContainEqual({ tag: 'a', count: 0 });
    expect(tags).toContainEqual({ tag: 'a/b', count: 0 });
    const lines = renderKnownTags(tags).split('\n');
    const child = lines.indexOf('  project/stagewise-io (2)');
    expect(lines[child - 1]).toBe('project (0)');
    expect(lines.indexOf('  a/b (0)')).toBe(lines.indexOf('a (0)') + 1);
  });

  it('keeps children directly under their parent despite dash-named siblings', () => {
    const lines = renderKnownTags(
      knownTags([
        tagged('project'),
        tagged('project-x'),
        tagged('project/sub'),
      ]),
    ).split('\n');
    expect(lines.indexOf('  project/sub (1)')).toBe(
      lines.indexOf('project (1)') + 1,
    );
  });

  it('counts an entity once per tag and keeps unused defaults', () => {
    const tags = knownTags([tagged('people', 'people')]);
    expect(tags).toContainEqual({ tag: 'people', count: 1 });
    expect(tags).toContainEqual({ tag: 'events/meetings', count: 0 });
  });
});

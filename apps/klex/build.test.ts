import { describe, expect, it } from 'vitest';

import { createBuildOptions } from './build';

describe('createBuildOptions', () => {
  it('embeds the application version in both build modes', () => {
    // The SEA branch adds its own `define` for __dirname. Object spreads
    // replace `define` wholesale rather than merging it, so forgetting to
    // spread the shared defines back in silently drops __KLEX_VERSION__ from
    // exactly the build that ships to users. The executable then falls back to
    // the package.json version at runtime, which looks like a correct build and
    // reports the wrong version to every installed user.
    for (const isSea of [false, true]) {
      const { main, worker } = createBuildOptions(isSea);
      expect(main.define?.__KLEX_VERSION__, `main, isSea=${isSea}`).toBeTypeOf(
        'string',
      );
      expect(
        worker.define?.__KLEX_VERSION__,
        `worker, isSea=${isSea}`,
      ).toBeTypeOf('string');
    }
  });

  it('defines production mode only for SEA artifacts', () => {
    for (const target of ['main', 'worker'] as const) {
      expect(
        createBuildOptions(true)[target].define?.['process.env.NODE_ENV'],
      ).toBe(JSON.stringify('production'));
      expect(
        createBuildOptions(false)[target].define?.['process.env.NODE_ENV'],
      ).toBeUndefined();
    }
  });

  it('keeps the __dirname redirect that fluent-ffmpeg needs in SEA builds', () => {
    expect(createBuildOptions(true).main.define?.__dirname).toBe(
      'import.meta.dirname',
    );
    expect(createBuildOptions(false).main.define?.__dirname).toBeUndefined();
  });
});

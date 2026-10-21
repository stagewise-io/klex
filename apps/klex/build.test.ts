import { resolve } from 'node:path';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { runInNewContext } from 'node:vm';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { createBuildOptions } from './build';

// Exercise the actual Vitest load hook, including its query-suffix handling.
const prompts = import.meta.glob<string>(
  [
    './src/session/chat/instinct/classifier-prompt.md',
    './src/session/chat/extensions/memory/retrieval/retrieval-prompt.md',
  ],
  {
    eager: true,
    import: 'default',
  },
);
const queriedPrompts = import.meta.glob<string>(
  [
    './src/session/chat/instinct/classifier-prompt.md',
    './src/session/chat/extensions/memory/retrieval/retrieval-prompt.md',
  ],
  {
    eager: true,
    import: 'default',
    query: '?loader-parity',
  },
);

describe('markdown loader parity', () => {
  it('discovers prompt files, including the instinct classifier prompt', () => {
    expect(prompts).toHaveProperty(
      './src/session/chat/instinct/classifier-prompt.md',
    );
    expect(Object.keys(queriedPrompts)).toEqual(Object.keys(prompts));
  });

  it('uses the text loader in both targets and build modes', () => {
    for (const isSea of [false, true]) {
      for (const target of ['main', 'worker'] as const) {
        expect(createBuildOptions(isSea)[target].loader?.['.md']).toBe('text');
        expect(createBuildOptions(isSea)[target].loader?.['.wasm']).toBe(
          'binary',
        );
        expect(createBuildOptions(isSea)[target].loader?.['.so']).toBe(
          'binary',
        );
      }
    }
  });

  it.each(Object.entries(prompts))(
    'matches the production text loader: %s',
    async (path, prompt) => {
      const result = await build({
        stdin: {
          contents: `export { default } from ${JSON.stringify(resolve(import.meta.dirname, path))};`,
          loader: 'js',
          resolveDir: import.meta.dirname,
        },
        loader: createBuildOptions(false).main.loader,
        bundle: true,
        write: false,
        format: 'cjs',
      });
      const output = result.outputFiles[0];
      expect(output).toBeDefined();
      if (!output) throw new Error('Missing bundled prompt');
      const module = { exports: {} as { default: string } };
      runInNewContext(output.text, { module, exports: module.exports });

      expect(module.exports.default).toBeTypeOf('string');
      expect(prompt).toBe(module.exports.default);
      expect(queriedPrompts[path]).toBe(module.exports.default);
    },
  );
});

describe('createBuildOptions', () => {
  it('runs the SEA worker with embedded engine and Encoding binaries outside the repository', async () => {
    const bundle = await build({
      ...createBuildOptions(true).worker,
      write: false,
    });
    const directory = await mkdtemp(resolve(tmpdir(), 'klex-wasm-test-'));
    let worker: Worker | undefined;
    try {
      const path = resolve(directory, 'worker.mjs');
      await writeFile(path, bundle.outputFiles[0]!.contents);
      worker = new Worker(path);
      const ready = once(worker, 'message');
      worker.postMessage({ type: 'initialize' });
      expect(await ready).toEqual([{ type: 'ready' }]);
      const complete = once(worker, 'message');
      worker.postMessage({
        type: 'execute',
        executionId: 'embedded-wasm',
        source: `return new TextDecoder().decode(new TextEncoder().encode('héllo 🌍'));`,
        snapshot: { namespaces: [] },
        deadline: Date.now() + 5_000,
      });
      expect(await complete).toEqual([
        { type: 'complete', executionId: 'embedded-wasm', result: 'héllo 🌍' },
      ]);
    } finally {
      await worker?.terminate();
      await rm(directory, { recursive: true, force: true });
    }
  });

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

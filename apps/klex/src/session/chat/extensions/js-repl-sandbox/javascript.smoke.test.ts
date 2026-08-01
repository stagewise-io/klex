import { existsSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { InMemoryToolProvider } from './in-memory-tool-provider.fixture';
import { createJavaScriptTool } from './javascript';

const workerUrl = new URL(
  '../../../../../dist/javascript-sandbox-worker.js',
  import.meta.url,
);
const logging = {
  child: () => ({ info: () => undefined }) as unknown as ModuleLogger,
} as unknown as RootLogger;

describe('packaged JavaScript sandbox Worker', () => {
  beforeAll(() => {
    if (!existsSync(workerUrl)) {
      throw new Error(
        'Packaged Worker is missing; run the Klex Agent build before this smoke test',
      );
    }
  });

  it('runs the file-backed bundle without ambient Node authority', async () => {
    const javaScriptTool = createJavaScriptTool({
      logging,
      provider: new InMemoryToolProvider(),
      workerUrl,
    });
    await javaScriptTool.start();
    try {
      await expect(
        javaScriptTool.execute({
          code: `globalThis.packaged = 41; return {
            value: await mcp['git.hub']['echo-value']({ packaged: true }),
            process: typeof process,
            require: typeof require,
          }`,
        }),
      ).resolves.toEqual({
        value: { packaged: true },
        process: 'undefined',
        require: 'undefined',
      });
      await expect(
        javaScriptTool.execute({ code: `return globalThis.packaged + 1` }),
      ).resolves.toBe(42);
      await expect(
        javaScriptTool.execute({
          code: `console.log('first'); return 'second'`,
        }),
      ).resolves.toEqual(['first', 'second']);
      await javaScriptTool.reset();
      await expect(
        javaScriptTool.execute({ code: `return typeof globalThis.packaged` }),
      ).resolves.toBe('undefined');
    } finally {
      await javaScriptTool.close();
    }
  });
});

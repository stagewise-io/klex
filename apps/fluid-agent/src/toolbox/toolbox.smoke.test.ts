import { existsSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { InMemoryCapabilityProvider } from './in-memory-provider.fixture';
import { createToolbox } from './toolbox';

const workerUrl = new URL('../../dist/toolbox-worker.js', import.meta.url);
const logging = {
  child: () => ({ info: () => undefined }) as unknown as ModuleLogger,
} as unknown as RootLogger;

describe('packaged Toolbox Worker', () => {
  beforeAll(() => {
    if (!existsSync(workerUrl)) {
      throw new Error(
        'Packaged Worker is missing; run the Fluid Agent build before this smoke test',
      );
    }
  });

  it('runs the file-backed bundle without ambient Node authority', async () => {
    const toolbox = createToolbox({
      logging,
      provider: new InMemoryCapabilityProvider(),
      workerUrl,
    });
    await toolbox.start();
    try {
      await expect(
        toolbox.execute({
          code: `globalThis.packaged = 41; output({
            value: await mcp['git.hub']['echo-value']({ packaged: true }),
            process: typeof process,
            require: typeof require,
          })`,
        }),
      ).resolves.toEqual({
        value: { packaged: true },
        process: 'undefined',
        require: 'undefined',
      });
      await expect(
        toolbox.execute({ code: `return globalThis.packaged + 1` }),
      ).resolves.toBe(42);
      await expect(
        toolbox.execute({ code: `output('first'); return 'second'` }),
      ).resolves.toEqual(['first', 'second']);
      await toolbox.reset();
      await expect(
        toolbox.execute({ code: `output(typeof globalThis.packaged)` }),
      ).resolves.toBe('undefined');
    } finally {
      await toolbox.close();
    }
  });
});

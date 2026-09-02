import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertGeneratedOutputsCurrent,
  canonicalizeGeneratedOutput,
} from '../../../scripts/generated-schema-output.js';

const temporaryDirectories: string[] = [];
const packageRoot = resolve(import.meta.dirname, '..');
const typescriptPath = join(packageRoot, 'src/generated/schema.ts');
const jsonPath = join(packageRoot, 'schema.json');

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'generated-schema-output-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('canonicalizeGeneratedOutput', () => {
  it('applies repository TypeScript formatting and import organization', () => {
    const raw = `import { z } from 'zod/v4';\nimport { ContentBlockSchema } from '@modelcontextprotocol/core';\nconst ExampleSchema=z.object({value:z.string(),content:ContentBlockSchema});\n`;

    expect(canonicalizeGeneratedOutput(raw, typescriptPath)).toBe(
      `import { ContentBlockSchema } from '@modelcontextprotocol/core';\nimport { z } from 'zod/v4';\n\nconst ExampleSchema = z.object({\n  value: z.string(),\n  content: ContentBlockSchema,\n});\n`,
    );
  });

  it('applies repository JSON formatting', () => {
    const raw = '{"items":["user","assistant"],"enabled":true}\n';

    expect(canonicalizeGeneratedOutput(raw, jsonPath)).toBe(
      '{ "items": ["user", "assistant"], "enabled": true }\n',
    );
  });

  it('is byte-idempotent for TypeScript and JSON', () => {
    const rawTypescript = `import {z} from 'zod/v4';\nexport const ExampleSchema=z.object({value:z.string()});\n`;
    const rawJson = '{"required":["first","second"],"type":"object"}\n';

    const typescript = canonicalizeGeneratedOutput(
      rawTypescript,
      typescriptPath,
    );
    const json = canonicalizeGeneratedOutput(rawJson, jsonPath);

    expect(canonicalizeGeneratedOutput(typescript, typescriptPath)).toBe(
      typescript,
    );
    expect(canonicalizeGeneratedOutput(json, jsonPath)).toBe(json);
  });
});

describe('assertGeneratedOutputsCurrent', () => {
  it('accepts an exact byte match', () => {
    const filePath = join(createTemporaryDirectory(), 'schema.json');
    writeFileSync(filePath, 'expected\n', 'utf8');

    expect(() =>
      assertGeneratedOutputsCurrent([{ expected: 'expected\n', filePath }]),
    ).not.toThrow();
  });

  it('distinguishes missing and stale output without writing', () => {
    const directory = createTemporaryDirectory();
    const missingFile = join(directory, 'missing.json');
    const staleFile = join(directory, 'stale.json');
    writeFileSync(staleFile, 'original\n', 'utf8');

    expect(() =>
      assertGeneratedOutputsCurrent([
        { expected: 'expected\n', filePath: missingFile },
        { expected: 'expected\n', filePath: staleFile },
      ]),
    ).toThrow(/missing\.json does not exist[\s\S]*stale\.json is stale/);
    expect(existsSync(missingFile)).toBe(false);
    expect(readFileSync(staleFile, 'utf8')).toBe('original\n');
  });
});

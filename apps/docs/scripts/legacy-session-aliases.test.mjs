import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('./legacy-session-aliases.mjs', import.meta.url),
);
const locales = [
  '',
  'ar',
  'de',
  'es',
  'fr',
  'hi',
  'ja',
  'ko',
  'pt',
  'ru',
  'uk',
  'zh',
];
const routes = [
  ['bot/concepts/cognitive-architecture', 'concepts/cognitive-architecture'],
  ['bot/concepts/soul', 'concepts/soul'],
  ['bot/quickstart', 'quickstart'],
];

test('legacy paths serve current pages with their fragments intact', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'klex-legacy-alias-'));
  try {
    for (const locale of locales) {
      for (const [source] of routes) {
        const file = join(cwd, 'dist', locale, source, 'index.html');
        await mkdir(dirname(file), { recursive: true });
        await writeFile(
          file,
          '<html><a id="creator-mode"></a><p>' +
            locale +
            ':' +
            source +
            '</p></html>',
        );
      }
    }
    execFileSync(process.execPath, [script], { cwd });
    for (const locale of locales) {
      for (const [source, target] of routes) {
        const base = join(cwd, 'dist', locale);
        assert.equal(
          await readFile(join(base, target, 'index.html'), 'utf8'),
          await readFile(join(base, source, 'index.html'), 'utf8'),
          (locale || 'en') + ': ' + target,
        );
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

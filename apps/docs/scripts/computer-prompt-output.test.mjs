// Run after the docs build: node --test apps/docs/scripts/computer-prompt-output.test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
test('generated text and API outputs retain the setup prompt without HTML controls', async () => {
  const markdown = await readFile(`${dist}/bot/guides/computers.md`, 'utf8');
  const full = await readFile(`${dist}/llms-full.txt`, 'utf8');
  const page = JSON.parse(
    await readFile(`${dist}/api/docs/pages/bot/guides/computers.json`, 'utf8'),
  );
  for (const text of [markdown, full, page.markdown]) {
    assert.match(text, /Help me run my already-enrolled klex-machine/);
    assert.doesNotMatch(text, /copy-agent-prompt|agent-prompt-details/);
  }
});

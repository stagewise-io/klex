import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// A static meta-refresh drops URL fragments. Serve current sessions and
// quickstart pages at pre-tab paths to preserve deep links without JavaScript.
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
for (const locale of locales) {
  const base = join('dist', locale);
  const source = join(base, 'bot/concepts/cognitive-architecture/index.html');
  const destination = join(base, 'concepts/cognitive-architecture');
  await mkdir(destination, { recursive: true });
  await copyFile(source, join(destination, 'index.html'));
  const quickstart = join(base, 'quickstart');
  await mkdir(quickstart, { recursive: true });
  await copyFile(
    join(base, 'bot/quickstart/index.html'),
    join(quickstart, 'index.html'),
  );
}

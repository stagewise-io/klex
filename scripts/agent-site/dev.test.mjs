import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { afterAll, beforeAll, expect, it } from 'vitest';

let child;
const origin = 'http://127.0.0.1:4193';
beforeAll(async () => {
  child = spawn(
    'pnpm',
    [
      '--filter',
      '@klex/website',
      'exec',
      'vite',
      '--host',
      '127.0.0.1',
      '--port',
      '4193',
      '--strictPort',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Vite startup timed out')),
      20000,
    );
    child.stdout.on('data', (data) => {
      if (String(data).includes('4193')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Vite exited ${code}`));
    });
  });
}, 25000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});

it('serves negotiated and explicit translated Markdown from live Vite', async () => {
  for (const path of ['/', '/index.md', '/brand.md', '/press.md']) {
    const response = await fetch(`${origin}${path}`, {
      headers: { Accept: 'text/markdown', 'Accept-Language': 'de' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-language')).toBe('de');
    if (path === '/' || path === '/index.md')
      expect(await response.text()).toContain('Dein eigenes Team');
  }
  const cookie = await fetch(`${origin}/index.md`, {
    headers: { Cookie: 'klex-language=fr', 'Accept-Language': 'de' },
  });
  expect(cookie.headers.get('content-language')).toBe('fr');
  const head = await fetch(`${origin}/index.md`, {
    method: 'HEAD',
    headers: { 'Accept-Language': 'de' },
  });
  expect(head.headers.get('content-language')).toBe('de');
  expect(await head.text()).toBe('');
  const html = await fetch(origin, { headers: { Accept: 'text/html' } });
  expect(html.headers.get('content-type')).toContain('text/html');
}, 60000);

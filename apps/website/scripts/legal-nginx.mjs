import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { fixtureSources, template } from '../src/legal/fixtures.ts';
import { generateArtifacts } from '../src/legal/node/index.ts';

const docker = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'klex-legal-nginx-'));
let container;
try {
  const root = join(temporary, 'html');
  await mkdir(root);
  const sources = fixtureSources();
  for (const [path, bytes] of generateArtifacts(sources, template)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(join(root, 'index.html'), 'NON_LEGAL_HOMEPAGE');
  const guide = await readFile(new URL('../LEGAL.md', import.meta.url), 'utf8');
  const snippet = guide.match(/```nginx\n([\s\S]*?)\n```/)?.[1];
  assert(snippet, 'Documented nginx configuration missing');
  const config = join(temporary, 'default.conf');
  await writeFile(
    config,
    `server { listen 80; root /usr/share/nginx/html; location / { try_files $uri /index.html; }\n${snippet}\n}`,
  );
  const started = await docker('docker', [
    'run',
    '--detach',
    '--rm',
    '--publish',
    '127.0.0.1::80',
    '--volume',
    `${root}:/usr/share/nginx/html:ro`,
    '--volume',
    `${config}:/etc/nginx/conf.d/default.conf:ro`,
    'nginx:1.28.0-alpine',
  ]);
  container = started.stdout.trim();
  await docker('docker', ['exec', container, 'nginx', '-t']);
  const port = (await docker('docker', ['port', container, '80/tcp'])).stdout
    .trim()
    .match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  assert(port, 'Missing loopback nginx test port');
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      ready =
        (
          await fetch(`${base}/legal/policies.json`, {
            signal: AbortSignal.timeout(1000),
          })
        ).status === 200;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, 'Nginx fixture did not become ready');
  for (const path of [
    '/legal/privacy',
    '/legal/privacy/',
    '/legal/privacy/2020-01-01',
    '/legal/privacy/2020-01-01/',
    '/legal/privacy/2099-01-01',
  ]) {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(await response.text(), /Synthetic|Privacy Policy/);
  }
  for (const path of [
    '/legal',
    '/legal/unknown',
    '/legal/missing.json',
    '/legal/privacy/2020-12-99',
    '/legal/privacy/missing.md',
  ]) {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 404);
    assert(!(await response.text()).includes('NON_LEGAL_HOMEPAGE'));
  }
  for (const path of ['/legal/policies.json', '/legal/privacy/2020-01-01.md']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`${base}${path}`, {
        method,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(
        response.headers.get('content-type'),
        path.endsWith('.md') ? /^text\/markdown/ : /^application\/json/,
      );
      assert(response.headers.get('etag'));
      const bytes = Buffer.from(await response.arrayBuffer());
      if (method === 'HEAD') assert.equal(bytes.length, 0);
      else if (path.endsWith('.md')) {
        const original = sources.revisions.find(
          (entry) => entry.revision === '2020-01-01',
        );
        assert(bytes.equals(original.bytes));
        assert.equal(
          createHash('sha256').update(bytes).digest('hex'),
          original.sha256,
        );
      } else
        assert.equal(JSON.parse(bytes.toString()).policies.privacy.length, 4);
    }
  }
  const original = await fetch(`${base}/legal/policies.json`);
  const revalidated = await fetch(`${base}/legal/policies.json`, {
    headers: { 'If-None-Match': original.headers.get('etag') },
  });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get('cache-control'), 'no-cache');
  console.log(
    'Legal nginx smoke passed: documented config, dated/slashless pages, real 404s despite SPA fallback, MIME/cache/GET/HEAD/revalidation and exact-byte SHA-256 downloads.',
  );
} finally {
  if (container)
    await docker('docker', ['rm', '--force', container]).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}

#!/usr/bin/env node
// End-to-end smoke test for the desktop_* tools against a local-mode daemon.
// Usage inside the spike container: node smoke.mjs [http://127.0.0.1:3123/mcp] [out-dir]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:3123/mcp';
const outDir = process.argv[3] ?? '/tmp/desktop-smoke';
let nextId = 1;

async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  const message = JSON.parse(data ?? text);
  if (message.error) throw new Error(`${method}: ${message.error.message}`);
  return message.result;
}

const timings = [];
async function call(name, args = {}) {
  const started = performance.now();
  const result = await rpc('tools/call', { name, arguments: args });
  timings.push({ name, ms: Math.round(performance.now() - started) });
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
  return result;
}

const json = (result) =>
  JSON.parse(result.content.find((part) => part.type === 'text').text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveImage(name, result) {
  const image = result.content.find((part) => part.type === 'image');
  if (!image) throw new Error(`${name}: no image content`);
  const bytes = Buffer.from(image.data, 'base64');
  const extension = image.mimeType === 'image/png' ? 'png' : 'jpg';
  await writeFile(join(outDir, `${name}.${extension}`), bytes);
  return bytes.length;
}

async function chromeWindow(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const windows = json(await call('desktop_list_windows'));
    const match = windows.find(
      (window) => window.title.includes('Google Chrome') && predicate(window),
    );
    if (match) return match;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out; windows: ${windows.map((window) => window.title).join(' | ')}`,
      );
    await sleep(300);
  }
}

const check = (label, ok, detail = '') => {
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`,
  );
  if (!ok) process.exitCode = 1;
};

const page = `<title>ready</title><body style="margin:0;height:4000px;font:32px sans-serif">
<button style="position:fixed;left:0;top:0;width:100vw;height:45vh;font-size:40px" onclick="document.title='clicked'">Click me</button>
<input style="position:fixed;left:0;top:55vh;width:100vw;height:20vh;font-size:40px" oninput="document.title='typed:'+this.value">
<script>onscroll=()=>{document.title='scrolled:'+Math.round(scrollY)};onkeydown=(e)=>{if(e.key==='F2')document.title='key:F2'}</script>`;

await mkdir(outDir, { recursive: true });
await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'desktop-smoke', version: '0' },
});
const { tools } = await rpc('tools/list');
const desktopTools = tools
  .map((tool) => tool.name)
  .filter((name) => name.startsWith('desktop_'));
check(
  'desktop tools advertised',
  desktopTools.length === 11,
  desktopTools.join(','),
);

const first = await call('desktop_screenshot');
const firstMeta = json(first);
check(
  'screenshot',
  firstMeta.width === 1280 && firstMeta.height === 800,
  `${firstMeta.width}x${firstMeta.height}, ${await saveImage('01-empty-desktop', first)} bytes`,
);

const launched = json(
  await call('desktop_launch', {
    command: 'browser',
    args: [
      '--window-position=0,0',
      '--window-size=1280,800',
      `data:text/html,${encodeURIComponent(page)}`,
    ],
  }),
);
check('launch', Number.isInteger(launched.pid), `pid ${launched.pid}`);
const browser = await chromeWindow((window) =>
  window.title.startsWith('ready'),
);
const { x, y, width, height } = browser.bounds;
check('list windows', true, `${browser.title} ${width}x${height}+${x}+${y}`);

await call('desktop_focus_window', { id: browser.id });
const cx = Math.round(x + width / 2);
await call('desktop_click', { x: cx, y: Math.round(y + height * 0.35) });
check(
  'click',
  !!(await chromeWindow((window) => window.title.startsWith('clicked'))),
);

await call('desktop_click', { x: cx, y: Math.round(y + height * 0.72) });
await call('desktop_type', { text: 'hello klex' });
check(
  'type',
  !!(await chromeWindow((window) =>
    window.title.startsWith('typed:hello klex'),
  )),
);

await call('desktop_key', { keys: ['F2'] });
check(
  'key',
  !!(await chromeWindow((window) => window.title.startsWith('key:F2'))),
);

await call('desktop_scroll', {
  x: cx,
  y: Math.round(y + height * 0.9),
  direction: 'down',
  amount: 5,
});
check(
  'scroll',
  !!(await chromeWindow((window) => window.title.startsWith('scrolled:'))),
);

await call('desktop_drag', {
  from: { x: cx - 200, y: Math.round(y + height * 0.9) },
  to: { x: cx + 200, y: Math.round(y + height * 0.9) },
});
await call('desktop_move', { x: 10, y: 10 });
check('drag and move', true);

const after = await call('desktop_key', { keys: ['ctrl+a'], screenshot: true });
check(
  'screenshot after action',
  after.content.some((part) => part.type === 'image'),
  `${await saveImage('02-after-actions', after)} bytes`,
);

const zoom = await call('desktop_zoom', {
  x: 0,
  y: 0,
  width: 320,
  height: 200,
});
const zoomMeta = json(zoom);
check(
  'zoom',
  zoomMeta.width === 1280,
  `${zoomMeta.width}x${zoomMeta.height}, ${await saveImage('03-zoom', zoom)} bytes`,
);

const resource = await rpc('resources/read', { uri: 'desktop://screen' });
const blob = resource.contents?.[0]?.blob;
check(
  'resource desktop://screen',
  typeof blob === 'string' && blob.length > 1000,
  `${blob?.length ?? 0} base64 chars`,
);

const byTool = Object.groupBy(timings, (timing) => timing.name);
console.log(
  'latency ms (median):',
  Object.fromEntries(
    Object.entries(byTool).map(([name, entries]) => {
      const sorted = entries.map((entry) => entry.ms).toSorted((a, b) => a - b);
      return [name, sorted[Math.floor(sorted.length / 2)]];
    }),
  ),
);

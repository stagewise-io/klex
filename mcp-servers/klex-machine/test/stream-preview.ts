/**
 * Serves noVNC against klex-machine's desktop stream, for trying the stream
 * locally without Cloud:
 *
 *   pnpm preview:stream                 # this machine's desktop
 *   pnpm preview:stream --synthetic     # a test frame, logging input
 *   pnpm preview:stream --synthetic --record test/fixtures/rfb/novnc-x.json
 *
 * Then open http://127.0.0.1:6080. noVNC loads from jsDelivr unless
 * --novnc-dir points at an unpacked @novnc/novnc package.
 */
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';

import { WebSocketServer } from 'ws';

import { createDesktopProvider } from '../src/desktop/platform/index.js';
import { RfbServer } from '../src/desktop/rfb/index.js';
import { loadFrame, SyntheticCapture } from './rfb-test-client.js';

const NOVNC_CDN = 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.7.0';
const FRAME = 'desktop-260x140';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '6080' },
    synthetic: { type: 'boolean', default: false },
    record: { type: 'string' },
    'novnc-dir': { type: 'string' },
  },
});

let open: () => Promise<Duplex>;
let capture: SyntheticCapture | undefined;
if (args.synthetic) {
  capture = new SyntheticCapture(loadFrame(FRAME));
  const server = new RfbServer(capture.backend(), { name: 'synthetic' });
  open = async () => server.open();
} else {
  const provider = createDesktopProvider(process.env);
  if (!provider) throw new Error('The desktop is turned off on this machine');
  const capabilities = await provider.probe();
  console.log(`desktop: ${JSON.stringify(capabilities)}`);
  open = () => provider.openStream();
}

const novnc = args['novnc-dir'] ? '/novnc' : NOVNC_CDN;
const page = `<!doctype html>
<meta charset="utf-8">
<title>klex-machine stream</title>
<style>html, body, #screen { margin: 0; height: 100%; background: #222; }</style>
<div id="screen"></div>
<script type="module">
  import RFB from '${novnc}/core/rfb.js';
  const url = new URL('/websockify', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const rfb = new RFB(document.getElementById('screen'), url.href);
  rfb.scaleViewport = true;
  rfb.qualityLevel = Number(new URLSearchParams(location.search).get('quality') ?? 6);
  rfb.addEventListener('connect', () => (document.title = 'connected'));
  rfb.addEventListener('disconnect', () => (document.title = 'disconnected'));
  rfb.addEventListener('clipboard', (event) => {
    window.clipboardText = event.detail.text;
    console.log('clipboard from the desktop:', event.detail.text);
    navigator.clipboard?.writeText(event.detail.text).catch(() => {});
  });
  // Offers the browser clipboard to the desktop whenever the page gets focus.
  window.addEventListener('focus', () => {
    navigator.clipboard?.readText().then((text) => rfb.clipboardPasteFrom(text), () => {});
  });
  window.rfb = rfb;
</script>
`;

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.json': 'application/json',
};

const http = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const dir = args['novnc-dir'];
  if (dir && path.startsWith('/novnc/')) {
    const file = join(dir, normalize(path.slice('/novnc/'.length)));
    if (
      file.startsWith(dir) &&
      (await stat(file).catch(() => null))?.isFile()
    ) {
      response.setHeader(
        'content-type',
        TYPES[extname(file)] ?? 'application/octet-stream',
      );
      createReadStream(file).pipe(response);
      return;
    }
  }
  if (path === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(page);
    return;
  }
  response.statusCode = 404;
  response.end();
});

const recorded: string[] = [];
const sockets = new WebSocketServer({ server: http, path: '/websockify' });
sockets.on('connection', async (socket) => {
  let stream: Duplex;
  try {
    stream = await open();
  } catch (error) {
    console.error(`cannot stream: ${(error as Error).message}`);
    socket.close(1011);
    return;
  }
  stream.on('data', (chunk: Buffer) => socket.send(chunk));
  stream.on('close', () => socket.close());
  stream.on('error', (error) => console.error(error.message));
  socket.on('message', (data: Buffer) => {
    if (args.record) recorded.push(data.toString('hex'));
    stream.write(data);
  });
  socket.on('close', () => stream.destroy());
});

async function finish(): Promise<void> {
  if (args.record) {
    await writeFile(
      args.record,
      `${JSON.stringify({ frame: FRAME, client: recorded, input: capture?.input ?? [] }, null, 2)}\n`,
    );
    console.log(`recorded ${recorded.length} messages to ${args.record}`);
  }
  process.exit(0);
}
process.on('SIGINT', finish);
process.on('SIGTERM', finish);

http.listen(Number(args.port), '127.0.0.1', () => {
  console.log(`noVNC on http://127.0.0.1:${args.port}`);
});

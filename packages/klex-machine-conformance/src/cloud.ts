import {
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import {
  createEnvironmentId,
  createProxy,
  type McpProxy,
  type ProxyFrame,
} from '@klex/mcp-proxy-sdk/core';
import { createProxyHttp, type ProxyHttp } from '@klex/mcp-proxy-sdk/http';
import { createProxyNodeHandlers } from '@klex/mcp-proxy-sdk/server';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  jwtVerify,
  SignJWT,
} from 'jose';
import { type RawData, WebSocket, WebSocketServer } from 'ws';

import {
  type MachineReportedFacts,
  type ParsedMachineFacts,
  parseMachineFacts,
} from './machine-facts.js';

// --- A throwaway CA and localhost certificate, DER-encoded by hand. ---

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...content: Buffer[]) => tlv(0x30, ...content);
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);
function oid(value: string): Buffer {
  const [first, second, ...rest] = value.split('.').map(Number);
  const bytes = [first! * 40 + second!];
  for (const part of rest) {
    const encoded = [part & 0x7f];
    for (let n = part >> 7; n > 0; n >>= 7) encoded.unshift((n & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const utcTime = (date: Date) =>
  tlv(
    0x17,
    Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`),
  );
const name = (commonName: string) =>
  sequence(
    tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))),
  );
const extension = (id: string, critical: boolean, value: Buffer) =>
  sequence(
    oid(id),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    tlv(0x04, value),
  );
const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));

function certificate(
  subject: string,
  issuer: string,
  publicKey: KeyObject,
  signer: KeyObject,
  extensions: Buffer[],
): string {
  const serial = randomBytes(16);
  // Positive and minimally encoded: OpenSSL rejects a padded DER INTEGER.
  serial[0] = (serial[0]! & 0x3f) | 0x40;
  const now = Date.now();
  const tbs = sequence(
    explicit(0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_SHA256,
    name(issuer),
    sequence(
      utcTime(new Date(now - 3_600_000)),
      utcTime(new Date(now + 86_400_000)),
    ),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, sequence(...extensions)),
  );
  const signature = sign('sha256', tbs, signer);
  const der = sequence(
    tbs,
    ECDSA_SHA256,
    tlv(0x03, Buffer.from([0]), signature),
  );
  const base64 = der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

function localhostCertificates() {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caPem = certificate(
    'klex conformance CA',
    'klex conformance CA',
    ca.publicKey,
    ca.privateKey,
    [
      extension('2.5.29.19', true, sequence(tlv(0x01, Buffer.from([0xff])))),
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x01, 0x06]))),
    ],
  );
  const leafPem = certificate(
    'localhost',
    'klex conformance CA',
    leaf.publicKey,
    ca.privateKey,
    [
      extension('2.5.29.19', false, sequence()),
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))),
      extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1'))),
      extension(
        '2.5.29.17',
        false,
        sequence(
          tlv(0x82, Buffer.from('localhost')),
          tlv(0x87, Buffer.from([127, 0, 0, 1])),
        ),
      ),
    ],
  );
  return {
    caPem,
    leafPem,
    leafKey: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

// --- The fake Cloud. ---

export interface EnrolledMachine {
  machineId: string;
  clientId: string;
  jwk: JWK;
  deleted: boolean;
}

export interface TokenRequest {
  machineId: string;
  formKeys: string[];
  form: Record<string, string>;
  contentType: string | undefined;
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export interface MachineConnection {
  machineId: string;
  /** The facts Cloud would store, after its own validation. */
  facts: MachineReportedFacts | undefined;
  factsReport: ParsedMachineFacts | { status: 'invalid'; reason: 'storage' };
}

/** A frame the proxy exchanged with a machine. */
export interface RecordedFrame {
  machineId: string;
  to: 'machine' | 'proxy';
  frame: ProxyFrame;
}

export interface CloudPeer {
  path: string;
  upgrade: boolean;
  remotePort: number | undefined;
}

/** A machine's desktop control socket, seen from Cloud. */
export interface DesktopControl {
  readonly machineId: string;
  readonly socket: WebSocket;
  /** JSON messages from the machine, in arrival order. */
  readonly messages: Record<string, unknown>[];
  /** Resolves with the close code once the socket closes. */
  readonly closed: Promise<number>;
  send(message: Record<string, unknown>): void;
  /** The first message of `type` after the first `skip` of them. */
  next(type: string, skip?: number): Promise<Record<string, unknown>>;
}

/** A desktop stream socket the machine opened for a viewer. */
export interface DesktopStream {
  readonly streamId: string;
  readonly socket: WebSocket;
  /** Binary RFB bytes from the machine, concatenated. */
  readonly received: () => Buffer;
  readonly closed: Promise<number>;
}

export interface FakeDesktopCloud {
  readonly controls: DesktopControl[];
  /** The latest open control socket of a machine. */
  control(machineId: string): Promise<DesktopControl>;
  stream(streamId: string): Promise<DesktopStream>;
}

export interface FakeCloud {
  readonly baseUrl: string;
  readonly desktop: FakeDesktopCloud;
  readonly caFile: string;
  readonly machines: Map<string, EnrolledMachine>;
  readonly tokenRequests: TokenRequest[];
  readonly connections: MachineConnection[];
  readonly frames: RecordedFrame[];
  readonly enrollRequests: unknown[];
  /** Every HTTPS request and upgrade, with the client's port. */
  readonly peers: CloudPeer[];
  issueCode(): string;
  /** Plain-HTTP proxy URL for a machine's MCP endpoint. */
  mcpUrl(machineId: string): string;
  mcpResource(machineId: string): string;
  accessToken(
    principal: string,
    machineId: string,
    claims?: Record<string, unknown>,
  ): Promise<string>;
  /** Overrides a route's response, for failure tests. */
  override(
    route: 'enroll' | 'token' | 'prm',
    respond: ((response: ServerResponse) => void) | undefined,
  ): void;
  /**
   * Hands later authenticated machine WebSockets to `accept` instead of the
   * proxy, so a test can speak the frame protocol itself.
   */
  intercept(
    accept: ((socket: WebSocket, machineId: string) => void) | undefined,
  ): void;
  /** Severs machine WebSockets and revokes their tokens. */
  dropConnections(): void;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function serveProxyHttp(
  proxyHttp: ProxyHttp,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const abort = new AbortController();
  response.once('close', () => abort.abort());
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers))
    for (const item of [value ?? []].flat()) headers.append(name, item);
  const method = request.method ?? 'GET';
  const proxied = await proxyHttp.fetch(
    new Request(`http://${request.headers.host}${request.url ?? '/'}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: Buffer.concat(chunks) }),
      signal: abort.signal,
    }),
  );
  response.writeHead(proxied.status, Object.fromEntries(proxied.headers));
  if (!proxied.body) return void response.end();
  const reader = proxied.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  if (abort.signal.aborted) cancel();
  else abort.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(value))
        await once(response, 'drain', { signal: abort.signal });
    }
  } catch {}
  response.end();
}

async function poll<T>(check: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

const closedCode = (socket: WebSocket) =>
  new Promise<number>((done) => socket.once('close', (code) => done(code)));

const toBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);

const DESKTOP_CONTROL_PATH = '/api/machine-desktop/control';
const DESKTOP_STREAM_PATH = /^\/api\/machine-desktop\/streams\/([^/]+)$/;

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

export async function startFakeCloud(directory: string): Promise<FakeCloud> {
  const { caPem, leafPem, leafKey } = localhostCertificates();
  const caFile = join(directory, 'ca.pem');
  await writeFile(caFile, caPem);
  const signing = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const signingJwk = {
    ...(await exportJWK(signing.publicKey)),
    kid: 'cloud-1',
    alg: 'EdDSA',
    use: 'sig',
  };

  const codes = new Set<string>();
  const machines = new Map<string, EnrolledMachine>();
  const tokens = new Map<string, string>();
  const tokenRequests: TokenRequest[] = [];
  const connections: MachineConnection[] = [];
  const frames: RecordedFrame[] = [];
  const enrollRequests: unknown[] = [];
  const overrides = new Map<string, (response: ServerResponse) => void>();
  let nextMachine = 1;
  let intercept: ((socket: WebSocket, machineId: string) => void) | undefined;

  const authenticate = (request: IncomingMessage) => {
    const token = /^Bearer (.+)$/.exec(
      request.headers.authorization ?? '',
    )?.[1];
    const machineId = token ? tokens.get(token) : undefined;
    if (!machineId) return undefined;
    const parsed = parseMachineFacts(request);
    // jsonb rejects NUL, so Cloud would drop such a report when storing it.
    const report:
      | ParsedMachineFacts
      | { status: 'invalid'; reason: 'storage' } =
      parsed.status === 'valid' &&
      JSON.stringify(parsed.facts).includes('\\u0000')
        ? { status: 'invalid', reason: 'storage' }
        : parsed;
    connections.push({
      machineId,
      facts: report.status === 'valid' ? report.facts : undefined,
      factsReport: report,
    });
    return machineId;
  };

  const realProxy = createProxy();
  const proxy: McpProxy = {
    registerEnvironment: (environmentId, connection) =>
      realProxy.registerEnvironment(environmentId, {
        send: (frame) => {
          frames.push({ machineId: environmentId, to: 'machine', frame });
          return connection.send(frame);
        },
        onFrame: (handler) =>
          connection.onFrame((frame) => {
            frames.push({ machineId: environmentId, to: 'proxy', frame });
            handler(frame);
          }),
        onClose: (handler) => connection.onClose(handler),
        close: () => connection.close(),
      }),
    openExchange: (environmentId, request, options) =>
      realProxy.openExchange(environmentId, request, options),
    close: () => realProxy.close(),
  };
  const handlers = createProxyNodeHandlers({
    proxy,
    parseEnvironmentId: createEnvironmentId,
    routePrefix: '/machines/',
    environmentWebSocketPath: '/machine-connections',
    authenticateEnvironment: ({ request }) => {
      const machineId = authenticate(request);
      return machineId ? createEnvironmentId(machineId) : undefined;
    },
  });
  const rawSockets = new WebSocketServer({ noServer: true });

  const httpsServer = createHttpsServer({ cert: leafPem, key: leafKey });
  const httpsPort = await listen(httpsServer);
  const baseUrl = `https://127.0.0.1:${httpsPort}`;
  const issuer = `${baseUrl}/api/auth`;
  const resourceOf = (machineId: string) =>
    `${baseUrl}/api/machines/${machineId}/proxy-connection`;
  const mcpResource = (machineId: string) =>
    `${baseUrl}/machines/${machineId}/mcp`;

  const enroll = async (request: IncomingMessage, response: ServerResponse) => {
    const body = JSON.parse(await readBody(request)) as {
      enrollmentCode: string;
      jwks: { keys: JWK[] };
    };
    enrollRequests.push(body);
    if (!codes.delete(body.enrollmentCode))
      return json(response, 401, { error: 'invalid_code' });
    const jwk = body.jwks.keys[0]!;
    if (
      [...machines.values()].some(
        (machine) => !machine.deleted && machine.jwk.kid === jwk.kid,
      )
    )
      return json(response, 409, { error: 'already_enrolled' });
    const machineId = `machine-${nextMachine++}`;
    machines.set(machineId, {
      machineId,
      clientId: `client-${machineId}`,
      jwk,
      deleted: false,
    });
    json(response, 200, {
      machineId,
      clientId: `client-${machineId}`,
      tokenEndpoint: `${issuer}/oauth2/token`,
      proxyConnectionResource: resourceOf(machineId),
      proxyConnectionUrl: `wss://127.0.0.1:${httpsPort}/machine-connections`,
      mcpResourceUrl: mcpResource(machineId),
      oauthProtectedResourceUrl: `${baseUrl}/api/machines/${machineId}/oauth-protected-resource`,
    });
  };

  const token = async (request: IncomingMessage, response: ServerResponse) => {
    const params = new URLSearchParams(await readBody(request));
    const form = Object.fromEntries(params);
    const machine = [...machines.values()].find(
      (candidate) =>
        candidate.clientId === form.client_id && !candidate.deleted,
    );
    if (!machine) return json(response, 401, { error: 'invalid_client' });
    try {
      const { payload, protectedHeader } = await jwtVerify(
        form.client_assertion ?? '',
        createLocalJWKSet({ keys: [machine.jwk] }),
        {
          issuer: machine.clientId,
          subject: machine.clientId,
          audience: issuer,
        },
      );
      tokenRequests.push({
        machineId: machine.machineId,
        formKeys: [...params.keys()],
        form,
        contentType: request.headers['content-type'],
        header: protectedHeader as Record<string, unknown>,
        claims: payload as Record<string, unknown>,
      });
    } catch {
      return json(response, 401, { error: 'invalid_client' });
    }
    if (
      form.grant_type !== 'client_credentials' ||
      form.scope !== 'machine:connect' ||
      form.resource !== resourceOf(machine.machineId)
    )
      return json(response, 400, { error: 'invalid_request' });
    const accessToken = randomBytes(24).toString('base64url');
    tokens.set(accessToken, machine.machineId);
    json(response, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  };

  const peers: CloudPeer[] = [];
  httpsServer.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);
    const path = url.pathname;
    peers.push({ path, upgrade: false, remotePort: request.socket.remotePort });
    const route =
      request.method === 'POST' && path === '/api/machines/enroll'
        ? 'enroll'
        : request.method === 'POST' && path === '/api/auth/oauth2/token'
          ? 'token'
          : /^\/api\/machines\/[^/]+\/oauth-protected-resource$/.test(path)
            ? 'prm'
            : undefined;
    const override = route && overrides.get(route);
    if (override) return override(response);
    if (route === 'enroll') return void enroll(request, response);
    if (route === 'token') return void token(request, response);
    if (route === 'prm') {
      const machineId = path.split('/')[3]!;
      return json(response, 200, {
        resource: mcpResource(machineId),
        authorization_servers: [issuer],
      });
    }
    if (path === '/api/auth/jwks')
      return json(response, 200, { keys: [signingJwk] });
    if (path.startsWith('/machines/'))
      return void handlers.handleHttp(request, response);
    json(response, 404, { error: 'not_found' });
  });
  const controls: DesktopControl[] = [];
  const streams = new Map<string, DesktopStream>();
  const acceptDesktop = (
    webSocket: WebSocket,
    machineId: string,
    path: string,
  ) => {
    const streamId = DESKTOP_STREAM_PATH.exec(path)?.[1];
    if (streamId) {
      const chunks: Buffer[] = [];
      webSocket.on('message', (data, isBinary) => {
        if (isBinary) chunks.push(toBuffer(data));
      });
      streams.set(streamId, {
        streamId,
        socket: webSocket,
        received: () => Buffer.concat(chunks),
        closed: closedCode(webSocket),
      });
      return;
    }
    const messages: Record<string, unknown>[] = [];
    webSocket.on('message', (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(data.toString()));
    });
    controls.push({
      machineId,
      socket: webSocket,
      messages,
      closed: closedCode(webSocket),
      send: (message) => webSocket.send(JSON.stringify(message)),
      next: (type, skip = 0) =>
        poll(
          () => messages.filter((message) => message.type === type)[skip],
          `a ${type} desktop control message`,
        ),
    });
  };
  const sockets = new Set<Duplex>();
  httpsServer.on('upgrade', (request, socket, head) => {
    peers.push({
      path: new URL(request.url ?? '/', baseUrl).pathname,
      upgrade: true,
      remotePort: request.socket.remotePort,
    });
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const path = new URL(request.url ?? '/', baseUrl).pathname;
    if (path === DESKTOP_CONTROL_PATH || DESKTOP_STREAM_PATH.test(path)) {
      const token = /^Bearer (.+)$/.exec(
        request.headers.authorization ?? '',
      )?.[1];
      const machineId = token ? tokens.get(token) : undefined;
      if (!machineId) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
        return;
      }
      rawSockets.handleUpgrade(request, socket, head, (webSocket) =>
        acceptDesktop(webSocket, machineId, path),
      );
      return;
    }
    const accept = intercept;
    if (!accept || request.url !== '/machine-connections')
      return void handlers.handleEnvironmentUpgrade(request, socket, head);
    const machineId = authenticate(request);
    if (!machineId) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      return;
    }
    rawSockets.handleUpgrade(request, socket, head, (webSocket) =>
      accept(webSocket, machineId),
    );
  });

  // Test clients reach the proxy over plain HTTP. The adapter cancels the
  // response as soon as the client goes away; toNodeHandler only notices on the
  // next chunk, which an idle SSE stream never sends.
  const proxyHttp = createProxyHttp({
    proxy,
    parseEnvironmentId: createEnvironmentId,
    routePrefix: '/machines/',
  });
  const httpServer = createHttpServer((request, response) => {
    void serveProxyHttp(proxyHttp, request, response);
  });
  const httpPort = await listen(httpServer);

  return {
    baseUrl,
    desktop: {
      controls,
      control: (machineId) =>
        poll(
          () =>
            controls.findLast(
              (control) =>
                control.machineId === machineId &&
                control.socket.readyState === WebSocket.OPEN,
            ),
          `the desktop control socket of ${machineId}`,
        ),
      stream: (streamId) =>
        poll(() => streams.get(streamId), `desktop stream ${streamId}`),
    },
    caFile,
    machines,
    tokenRequests,
    connections,
    frames,
    enrollRequests,
    peers,
    issueCode() {
      const code = `code-${randomBytes(8).toString('hex')}`;
      codes.add(code);
      return code;
    },
    mcpUrl: (machineId) =>
      `http://127.0.0.1:${httpPort}/machines/${machineId}/mcp`,
    mcpResource,
    accessToken: (principal, machineId, claims = {}) =>
      new SignJWT({ scope: 'mcp:use', client_id: principal, ...claims })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'cloud-1' })
        .setIssuer(issuer)
        .setAudience(mcpResource(machineId))
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    override(route, respond) {
      if (respond) overrides.set(route, respond);
      else overrides.delete(route);
    },
    intercept(accept) {
      intercept = accept;
    },
    dropConnections() {
      tokens.clear();
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      await handlers.close();
      await proxyHttp.close();
      await proxy.close();
      for (const client of rawSockets.clients) client.terminate();
      rawSockets.close();
      httpsServer.closeAllConnections();
      httpServer.closeAllConnections();
      await Promise.all([
        new Promise((done) => httpsServer.close(done)),
        new Promise((done) => httpServer.close(done)),
      ]);
    },
  };
}

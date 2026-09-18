import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { z } from 'zod/v4';

import type { AttioClient, Identity } from './attio.js';
import type { CredentialCipher } from './credentials.js';
import { AttioError } from './errors.js';
import type { Connection, ConnectionStore, Principal } from './store.js';
import { operation, type ToolName } from './tools.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const secretInput = z.strictObject({
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().min(1).max(16_384),
});
const requiredScopes = [
  'object_configuration:read',
  'record_permission:read-write',
];
export interface ServiceOptions {
  store: ConnectionStore;
  cipher: CredentialCipher;
  client: AttioClient;
  redirectUri: string;
  now?: () => number;
}
/** Trusted management API. The embedding host must authenticate the customer,
 * authorize management separately from MCP, and supply a verified browser session.
 * Never expose these methods as tools or trust principal/session IDs from a body.
 */
export class AttioService {
  private readonly now: () => number;
  constructor(private readonly options: ServiceOptions) {
    const url = new URL(options.redirectUri);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && url.hostname === '127.0.0.1')
    )
      throw new Error('Invalid configured callback');
    if (url.username || url.password || url.search || url.hash)
      throw new Error('Invalid configured callback');
    this.now = options.now ?? Date.now;
  }
  private context(
    connection: Connection,
    purpose: 'client-secret' | 'access-token',
  ) {
    return {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      purpose,
    };
  }
  private async owned(principal: Principal, id: string) {
    const row = await this.options.store.get(principal.tenantId, id);
    if (!row || row.principalId !== principal.principalId)
      throw new AttioError('NOT_FOUND');
    return row;
  }
  async status(principal: Principal, id: string) {
    const row = await this.owned(principal, id);
    return {
      id: row.id,
      status: row.status,
      workspaceId: row.workspaceId,
      scopes: row.scopes,
    };
  }
  async create(principal: Principal, input: unknown) {
    const parsed = secretInput.safeParse(input);
    if (!parsed.success) throw new AttioError('INVALID_INPUT');
    const id = randomUUID();
    const clientSecret = await this.options.cipher.seal(
      parsed.data.clientSecret,
      {
        tenantId: principal.tenantId,
        connectionId: id,
        purpose: 'client-secret',
      },
    );
    if (
      !(await this.options.store.create({
        id,
        ...principal,
        clientId: parsed.data.clientId,
        clientSecret,
        generation: 0,
        status: 'pending',
      }))
    )
      throw new AttioError('CONFLICT');
    return this.status(principal, id);
  }
  private async replace(row: Connection, patch: Partial<Connection>) {
    const next = { ...row, ...patch, generation: row.generation + 1 };
    if (!(await this.options.store.compareAndSet(next, row.generation)))
      throw new AttioError('RECONNECT_REQUIRED');
    return next;
  }
  async disconnect(principal: Principal, id: string) {
    // Retry CAS to ensure a racing callback cannot leave an active credential.
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = await this.owned(principal, id);
      if (
        await this.options.store.compareAndSet(
          {
            ...row,
            token: undefined,
            status: 'disconnected',
            generation: row.generation + 1,
          },
          row.generation,
        )
      )
        return;
    }
    throw new AttioError('UNAVAILABLE');
  }
  async rotateAppSecret(principal: Principal, id: string, secret: string) {
    if (!z.string().min(1).max(16_384).safeParse(secret).success)
      throw new AttioError('INVALID_INPUT');
    const row = await this.owned(principal, id);
    const clientSecret = await this.options.cipher.seal(
      secret,
      this.context(row, 'client-secret'),
    );
    await this.replace(row, {
      clientSecret,
      status: 'reconnect_required',
      token: undefined,
    });
  }
  async start(principal: Principal, id: string, browserSession: string) {
    if (!browserSession || browserSession.length > 4096)
      throw new AttioError('INVALID_STATE');
    const row = await this.replace(await this.owned(principal, id), {
      status: 'pending',
      token: undefined,
    });
    const state = randomBytes(32).toString('base64url');
    await this.options.store.putAttempt({
      stateHash: hash(state),
      ...principal,
      connectionId: id,
      sessionHash: hash(browserSession),
      generation: row.generation,
      expiresAt: this.now() + 600_000,
    });
    const url = new URL('https://app.attio.com/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: row.clientId,
      redirect_uri: this.options.redirectUri,
      state,
    }).toString();
    return { authorizationUrl: url.toString() };
  }
  private validateIdentity(identity: Identity, row: Connection) {
    const scopes = identity.scope.split(/\s+/);
    if (
      identity.client_id !== row.clientId ||
      (row.workspaceId !== undefined &&
        identity.workspace_id !== row.workspaceId) ||
      (identity.exp !== null && identity.exp * 1000 <= this.now()) ||
      requiredScopes.some((scope) => !scopes.includes(scope))
    )
      throw new AttioError('RECONNECT_REQUIRED');
    return scopes;
  }
  async callback(principal: Principal, browserSession: string, input: unknown) {
    const parsed = z
      .strictObject({
        state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code: z.string().min(1).max(4096).optional(),
        error: z.string().max(256).optional(),
      })
      .safeParse(input);
    if (!parsed.success) throw new AttioError('INVALID_STATE');
    const attempt = await this.options.store.consumeAttempt(
      hash(parsed.data.state),
      principal,
      hash(browserSession),
      this.now(),
    );
    if (!attempt) throw new AttioError('INVALID_STATE');
    const row = await this.owned(principal, attempt.connectionId);
    if (
      row.generation !== attempt.generation ||
      row.status !== 'pending' ||
      parsed.data.error !== undefined ||
      !parsed.data.code
    )
      throw new AttioError('INVALID_STATE');
    const secret = await this.options.cipher.open(
      row.clientSecret,
      this.context(row, 'client-secret'),
    );
    const token = await this.options.client.exchange(
      row.clientId,
      secret,
      parsed.data.code,
      this.options.redirectUri,
    );
    const identity = await this.options.client.introspect(token);
    const scopes = this.validateIdentity(identity, row);
    const encrypted = await this.options.cipher.seal(
      token,
      this.context(row, 'access-token'),
    );
    await this.replace(row, {
      status: 'active',
      workspaceId: identity.workspace_id,
      scopes,
      token: encrypted,
    });
    return this.status(principal, row.id);
  }
  async execute(
    principal: Principal,
    id: string,
    name: ToolName,
    input: unknown,
  ) {
    const op = operation(name, input);
    const row = await this.owned(principal, id);
    if (row.status !== 'active' || !row.token || !row.workspaceId)
      throw new AttioError('RECONNECT_REQUIRED');
    const guard = async () => {
      const current = await this.owned(principal, id);
      if (current.status !== 'active' || current.generation !== row.generation)
        throw new AttioError('RECONNECT_REQUIRED');
    };
    try {
      const token = await this.options.cipher.open(
        row.token,
        this.context(row, 'access-token'),
      );
      this.validateIdentity(await this.options.client.introspect(token), row);
      const result = await this.options.client.records(
        token,
        row.workspaceId,
        op,
        guard,
      );
      await guard();
      return result;
    } catch (error) {
      if (error instanceof AttioError && error.code === 'RECONNECT_REQUIRED') {
        await this.options.store.compareAndSet(
          {
            ...row,
            status: 'reconnect_required',
            token: undefined,
            generation: row.generation + 1,
          },
          row.generation,
        );
      }
      throw error;
    }
  }
}

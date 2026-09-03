import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { z } from 'zod';

const DEFAULT_ISSUER = '__default__';

const storedOAuthTokensSchema: z.ZodType<StoredOAuthTokens> = z.object({
  access_token: z.string(),
  expires_in: z.coerce.number().optional(),
  id_token: z.string().optional(),
  issuer: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string(),
});

const storedOAuthClientInformationSchema: z.ZodType<StoredOAuthClientInformation> =
  z
    .object({
      application_type: z.string().optional(),
      client_id: z.string(),
      client_id_issued_at: z.number().optional(),
      client_name: z.string().optional(),
      client_secret: z.string().optional(),
      client_secret_expires_at: z.number().optional(),
      client_uri: z.url().optional(),
      contacts: z.array(z.string()).optional(),
      grant_types: z.array(z.string()).optional(),
      issuer: z.string().optional(),
      jwks: z.unknown().optional(),
      jwks_uri: z.url().optional(),
      logo_uri: z.union([z.url(), z.literal('')]).optional(),
      policy_uri: z.string().optional(),
      redirect_uris: z.array(z.url()).optional(),
      response_types: z.array(z.string()).optional(),
      scope: z.string().optional(),
      software_id: z.string().optional(),
      software_statement: z.string().optional(),
      software_version: z.string().optional(),
      token_endpoint_auth_method: z.string().optional(),
      tos_uri: z.union([z.url(), z.literal('')]).optional(),
    })
    .passthrough();

const oauthDiscoveryStateSchema: z.ZodType<OAuthDiscoveryState> = z
  .object({
    authorizationServerUrl: z.string(),
    resourceMetadataUrl: z.string().optional(),
  })
  .passthrough();

const serverOAuthStateSchema = z.object({
  clientInformationByIssuer: z
    .record(z.string(), storedOAuthClientInformationSchema)
    .default({}),
  clientRedirectUrlsByIssuer: z.record(z.string(), z.url()).default({}),
  codeVerifier: z.string().optional(),
  discoveryState: oauthDiscoveryStateSchema.optional(),
  lastTokenIssuer: z.string().optional(),
  tokensByIssuer: z.record(z.string(), storedOAuthTokensSchema).default({}),
});

type ServerOAuthState = z.infer<typeof serverOAuthStateSchema>;

const oauthStoreSchema = z.object({
  servers: z.record(z.string(), serverOAuthStateSchema).default({}),
  version: z.literal(1),
});

type OAuthStoreData = z.infer<typeof oauthStoreSchema>;

export type OAuthCredentialScope =
  | 'all'
  | 'client'
  | 'tokens'
  | 'verifier'
  | 'discovery';

export class McpOAuthStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async clientInformation(
    serverName: string,
    redirectUrl: string,
    issuer?: string,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const server = await this.readServer(serverName);
    const issuerKey = issuer ?? DEFAULT_ISSUER;
    if (server?.clientRedirectUrlsByIssuer[issuerKey] !== redirectUrl)
      return undefined;
    return server.clientInformationByIssuer[issuerKey];
  }

  public async codeVerifier(serverName: string): Promise<string | undefined> {
    return (await this.readServer(serverName))?.codeVerifier;
  }

  public async discoveryState(
    serverName: string,
  ): Promise<OAuthDiscoveryState | undefined> {
    return (await this.readServer(serverName))?.discoveryState;
  }

  public async invalidate(
    serverName: string,
    scope: OAuthCredentialScope,
  ): Promise<void> {
    await this.mutate((data) => {
      const server = data.servers[serverName];
      if (!server) return;

      if (scope === 'all' || scope === 'client') {
        server.clientInformationByIssuer = {};
        server.clientRedirectUrlsByIssuer = {};
      }
      if (scope === 'all' || scope === 'tokens') {
        server.tokensByIssuer = {};
        delete server.lastTokenIssuer;
      }
      if (scope === 'all' || scope === 'verifier') delete server.codeVerifier;
      if (scope === 'all' || scope === 'discovery')
        delete server.discoveryState;
    });
  }

  public async saveClientInformation(
    serverName: string,
    redirectUrl: string,
    clientInformation: StoredOAuthClientInformation,
    issuer?: string,
  ): Promise<void> {
    await this.mutate((data) => {
      const server = this.getOrCreateServer(data, serverName);
      const issuerKey = issuer ?? clientInformation.issuer ?? DEFAULT_ISSUER;
      server.clientInformationByIssuer[issuerKey] = clientInformation;
      server.clientRedirectUrlsByIssuer[issuerKey] = redirectUrl;
    });
  }

  public async saveCodeVerifier(
    serverName: string,
    codeVerifier: string,
  ): Promise<void> {
    await this.mutate((data) => {
      this.getOrCreateServer(data, serverName).codeVerifier = codeVerifier;
    });
  }

  public async saveDiscoveryState(
    serverName: string,
    discoveryState: OAuthDiscoveryState,
  ): Promise<void> {
    await this.mutate((data) => {
      this.getOrCreateServer(data, serverName).discoveryState = discoveryState;
    });
  }

  public async saveTokens(
    serverName: string,
    tokens: StoredOAuthTokens,
    issuer?: string,
  ): Promise<void> {
    await this.mutate((data) => {
      const server = this.getOrCreateServer(data, serverName);
      const issuerKey = issuer ?? tokens.issuer ?? DEFAULT_ISSUER;
      server.tokensByIssuer[issuerKey] = tokens;
      server.lastTokenIssuer = issuerKey;
    });
  }

  public async tokens(
    serverName: string,
    issuer?: string,
  ): Promise<StoredOAuthTokens | undefined> {
    const server = await this.readServer(serverName);
    if (!server) return undefined;

    const issuerKey = issuer ?? server.lastTokenIssuer;
    return issuerKey ? server.tokensByIssuer[issuerKey] : undefined;
  }

  private getOrCreateServer(
    data: OAuthStoreData,
    serverName: string,
  ): ServerOAuthState {
    const existing = data.servers[serverName];
    if (existing) return existing;

    const created: ServerOAuthState = {
      clientInformationByIssuer: {},
      clientRedirectUrlsByIssuer: {},
      tokensByIssuer: {},
    };
    data.servers[serverName] = created;
    return created;
  }

  private async mutate(update: (data: OAuthStoreData) => void): Promise<void> {
    const mutation = this.mutationQueue.then(async () => {
      const data = await this.read();
      update(data);
      await this.write(data);
    });
    this.mutationQueue = mutation.catch(() => undefined);
    await mutation;
  }

  private async read(): Promise<OAuthStoreData> {
    try {
      return oauthStoreSchema.parse(
        JSON.parse(await readFile(this.filePath, 'utf8')),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { servers: {}, version: 1 };
      }
      throw error;
    }
  }

  private async readServer(
    serverName: string,
  ): Promise<ServerOAuthState | undefined> {
    await this.mutationQueue;
    return (await this.read()).servers[serverName];
  }

  private async write(data: OAuthStoreData): Promise<void> {
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });

    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

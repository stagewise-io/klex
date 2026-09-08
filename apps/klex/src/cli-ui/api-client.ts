const ADMIN_API_BASE = 'http://localhost:2706';

export interface ProviderMetadata {
  displayName: string;
  description: string;
  logoSvg?: string;
  documentationUrl?: string;
  capabilities: {
    modelDiscovery: boolean;
    connectivityTest: boolean;
    customModels: boolean;
  };
}

export interface ProviderTypeInfo extends ProviderMetadata {
  type: string;
  settingsSchema: Record<string, unknown>;
}
export interface ProviderInfo {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  metadata: ProviderMetadata;
  operations: {
    update: ProviderOperationAvailability;
    remove: ProviderOperationAvailability;
  };
}
export interface ProviderOperationAvailability {
  available: boolean;
  code?: string;
  message?: string;
  remediation?: string;
}
export interface ProviderResponse {
  providers: ProviderInfo[];
}
export interface ProviderTypesResponse {
  providerTypes: ProviderTypeInfo[];
}
export interface ProviderOperationResponse {
  ok: boolean;
  provider?: ProviderInfo;
}
export type ModelKind =
  | 'language'
  | 'speech-to-speech'
  | 'text-to-speech'
  | 'speech-to-text'
  | 'image-generation'
  | 'embedding'
  | 'reranking'
  | 'moderation'
  | 'unknown';

export interface KnownModel {
  modelId: string;
  kind?: ModelKind;
  displayName?: string;
  contextSize?: number;
  capabilities?: {
    input?: {
      image?: {
        mediaTypes?: string[];
        maxBytes?: number;
        maxWidth?: number;
        maxHeight?: number;
        maxTotalPixels?: number;
      };
      audio?: {
        mediaTypes?: string[];
        maxBytes?: number;
        maxLengthSeconds?: number;
      };
    };
    voice?: { sts?: boolean; tts?: boolean; stt?: boolean };
    tools?: boolean;
    reasoning?: boolean;
  };
  provenance?: Array<{
    source:
      | 'discovered'
      | 'shared-catalog'
      | 'provider-family'
      | 'provider-exact'
      | 'user';
    documentationUrl?: string;
    reviewedAt?: string;
  }>;
  source: 'manual' | 'discovered' | 'merged';
}

export interface KnownModelsResponse {
  models: KnownModel[];
}
export interface ConnectivityResponse {
  latencyMs: number;
  target?: string;
}

export interface McpServersResponse {
  servers: Array<{
    name: string;
    status: string;
    toolCount: number;
    supportsPushNotifications: boolean;
    transport: string;
  }>;
}

export interface ModelSelectionEntry {
  providerId: string;
  modelId: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export function entryToModelId(entry: ModelSelectionEntry): string {
  return `${entry.providerId}:${entry.modelId}`;
}

export interface ModelSelection {
  chat: ModelSelectionEntry[];
  compaction: ModelSelectionEntry[];
  memory: ModelSelectionEntry[];
  imageVision: ModelSelectionEntry[];
  audioListening: ModelSelectionEntry[];
  voice: {
    sts: ModelSelectionEntry[];
    tts: ModelSelectionEntry[];
    stt: ModelSelectionEntry[];
  };
  warnings?: Array<{ modelId: string; message: string }>;
}

export interface TelemetrySettings {
  level: string;
}

export interface AgentIdentity {
  officialName: string;
}

export type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface CloudStatus {
  cloudEnabled: boolean;
  enrolled: boolean;
  clientId: string | null;
  enrolledAt: string | null;
  cloudBaseUrl: string;
  tunnelState: TunnelState;
}

export interface CloudEnrollResult {
  clientId: string;
  enrolledAt: string;
}

export interface GodMessageResponse {
  sessionId: string;
}

export interface GodMessagesResponse {
  messages: SerializedMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SerializedPart {
  type: string;
  [key: string]: unknown;
}

export interface SerializedMessage {
  id: string;
  role: string;
  parts: SerializedPart[];
}

export interface IntrospectionNode {
  path: string[];
  state: Record<string, unknown> | null;
  children: Array<{ id: string; hasState: boolean; hasChildren: boolean }>;
}

export interface SessionInfo {
  id: string;
  status: string;
  runtimeState: string;
  model: { id: string | null; isFallback: boolean; fallbackIndex: number };
  usage: {
    chat: { latest: unknown; total: unknown };
    extensions: Record<string, unknown>;
  };
  turns: number;
  steps: number;
  messageCount: number;
  createdAt: string;
}

export interface UsageDataPoint {
  bucket: string | null;
  splitKey: string | null;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  inputCacheWriteTokens: number;
  inputCacheReadTokens: number;
  ttftMs: number | null;
  totalDurationMs: number | null;
  errorCount: number;
  id: string | null;
  sessionId: string | null;
  providerId: string | null;
  endpointId: string | null;
  modelId: string | null;
  source: 'chat' | 'extension' | null;
  extensionId: string | null;
  finishReason: string | null;
  errorType: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface UsageResponse {
  dataPoints: UsageDataPoint[];
}

export class AdminApiClientError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = 'AdminApiClientError';
  }
}

export class AdminApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    baseUrl = ADMIN_API_BASE,
    fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
  }

  private async request<T>(
    path: string,
    options?: { method?: string; body?: unknown; contentType?: string },
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: options?.method ?? 'GET',
      headers:
        options?.body !== undefined
          ? { 'Content-Type': options?.contentType ?? 'application/json' }
          : undefined,
      body:
        options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ error: response.statusText }));
      const failure = body as {
        error?: string;
        code?: string;
        remediation?: string;
      };
      const message = failure.error ?? `HTTP ${response.status}`;
      throw new AdminApiClientError(
        message,
        response.status,
        failure.code,
        failure.remediation,
      );
    }

    return (await response.json()) as T;
  }

  // --- Providers ---

  getProviderTypes(): Promise<ProviderTypesResponse> {
    return this.request<ProviderTypesResponse>('/v1/provider-types');
  }

  canAddProvider(
    type: string,
    settings: Record<string, unknown>,
  ): Promise<ProviderOperationResponse> {
    return this.request<ProviderOperationResponse>(
      `/v1/provider-types/${encodeURIComponent(type)}/can-add`,
      {
        method: 'POST',
        body: { settings },
      },
    );
  }

  getProviders(): Promise<ProviderResponse> {
    return this.request<ProviderResponse>('/v1/providers');
  }

  createProvider(body: {
    id: string;
    type: string;
    settings: Record<string, unknown>;
  }): Promise<ProviderOperationResponse> {
    return this.request<ProviderOperationResponse>('/v1/providers', {
      method: 'POST',
      body,
    });
  }

  updateProvider(
    id: string,
    body: { settings?: Record<string, unknown | null> },
  ): Promise<ProviderOperationResponse> {
    return this.request<ProviderOperationResponse>(
      `/v1/providers/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body,
        contentType: 'application/merge-patch+json',
      },
    );
  }

  deleteProvider(id: string): Promise<ProviderOperationResponse> {
    return this.request<ProviderOperationResponse>(
      `/v1/providers/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }

  testProvider(id: string): Promise<ConnectivityResponse> {
    return this.request<ConnectivityResponse>(
      `/v1/providers/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    );
  }

  getKnownModels(id: string, refresh = false): Promise<KnownModelsResponse> {
    return this.request<KnownModelsResponse>(
      `/v1/providers/${encodeURIComponent(id)}/models${refresh ? '?refresh=true' : ''}`,
    );
  }

  createKnownModel(id: string, body: unknown): Promise<KnownModelsResponse> {
    return this.request<KnownModelsResponse>(
      `/v1/providers/${encodeURIComponent(id)}/models`,
      { method: 'POST', body },
    );
  }

  updateKnownModel(
    id: string,
    modelId: string,
    body: unknown,
  ): Promise<KnownModelsResponse> {
    return this.request<KnownModelsResponse>(
      `/v1/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`,
      { method: 'PATCH', body },
    );
  }

  deleteKnownModel(id: string, modelId: string): Promise<KnownModelsResponse> {
    return this.request<KnownModelsResponse>(
      `/v1/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`,
      { method: 'DELETE' },
    );
  }

  // --- MCP ---

  getMcpServers(): Promise<McpServersResponse> {
    return this.request<McpServersResponse>('/v1/mcp-servers');
  }

  createMcpServer(body: unknown): Promise<McpServersResponse> {
    return this.request<McpServersResponse>('/v1/mcp-servers', {
      method: 'POST',
      body,
    });
  }

  updateMcpServer(name: string, body: unknown): Promise<McpServersResponse> {
    return this.request<McpServersResponse>(
      `/v1/mcp-servers/${encodeURIComponent(name)}`,
      { method: 'PATCH', body },
    );
  }

  deleteMcpServer(name: string): Promise<McpServersResponse> {
    return this.request<McpServersResponse>(
      `/v1/mcp-servers/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  }

  // --- Settings ---

  getAgentIdentity(): Promise<AgentIdentity> {
    return this.request<AgentIdentity>('/v1/settings/agent');
  }

  patchAgentIdentity(body: { officialName: string }): Promise<AgentIdentity> {
    return this.request<AgentIdentity>('/v1/settings/agent', {
      method: 'PATCH',
      body,
    });
  }

  getModelSelection(): Promise<ModelSelection> {
    return this.request<ModelSelection>('/v1/settings/model-selection');
  }

  patchModelSelection(body: unknown): Promise<ModelSelection> {
    return this.request<ModelSelection>('/v1/settings/model-selection', {
      method: 'PATCH',
      body,
    });
  }

  getTelemetry(): Promise<TelemetrySettings> {
    return this.request<TelemetrySettings>('/v1/settings/telemetry');
  }

  patchTelemetry(body: unknown): Promise<TelemetrySettings> {
    return this.request<TelemetrySettings>('/v1/settings/telemetry', {
      method: 'PATCH',
      body,
    });
  }

  // --- Cloud ---

  getCloudStatus(): Promise<CloudStatus> {
    return this.request<CloudStatus>('/v1/cloud/status');
  }

  enroll(enrollmentCode: string): Promise<CloudEnrollResult> {
    return this.request<CloudEnrollResult>('/v1/cloud/enroll', {
      method: 'POST',
      body: { enrollmentCode },
    });
  }

  // --- God Messages ---

  sendGodMessage(text: string): Promise<GodMessageResponse> {
    return this.request<GodMessageResponse>('/v1/god-messages', {
      method: 'POST',
      body: { content: [{ type: 'text', text }] },
    });
  }

  getGodSession(): Promise<SessionInfo> {
    return this.request<SessionInfo>('/v1/god-messages/session');
  }

  getGodMessages(
    limit?: number,
    cursor?: string,
  ): Promise<GodMessagesResponse> {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    const qs = query.toString();
    return this.request<GodMessagesResponse>(
      `/v1/god-messages/messages${qs ? `?${qs}` : ''}`,
    );
  }

  resetGodSession(): Promise<GodMessageResponse> {
    return this.request<GodMessageResponse>('/v1/god-messages/reset', {
      method: 'POST',
    });
  }

  // --- Usage ---

  getUsage(params?: {
    splitBy?: 'none' | 'model' | 'provider' | 'endpoint';
    from?: string;
    to?: string;
    granularity?: 'event' | 'hourly' | 'daily' | 'weekly';
    limit?: number;
  }): Promise<UsageResponse> {
    const query = new URLSearchParams();
    if (params?.splitBy) query.set('splitBy', params.splitBy);
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    if (params?.granularity) query.set('granularity', params.granularity);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return this.request<UsageResponse>(`/v1/usage${qs ? `?${qs}` : ''}`);
  }

  // --- Introspection ---

  getIntrospectionRoot(): Promise<IntrospectionNode> {
    return this.request<IntrospectionNode>('/v1/introspect');
  }

  getIntrospection(path: string): Promise<IntrospectionNode> {
    return this.request<IntrospectionNode>(`/v1/introspect/${path}`);
  }

  // --- Sessions ---

  async getSessions(): Promise<SessionInfo[]> {
    const root = await this.getIntrospectionRoot();
    const sessionsChild = root.children.find((c) => c.id === 'sessions');
    if (!sessionsChild) return [];

    const sessionsNode = await this.getIntrospection('sessions');
    if (!sessionsNode.state) return [];

    const sessions = sessionsNode.state as { sessions?: SessionInfo[] };
    return sessions.sessions ?? [];
  }
}

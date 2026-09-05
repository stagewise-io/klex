const ADMIN_API_BASE = 'http://localhost:2706';

export interface ProviderResponse {
  providers: Array<
    | {
        name: string;
        preset: string;
        auth: { apiKey?: string; headers?: Record<string, string> };
      }
    | {
        name: string;
        endpoints: Record<
          string,
          {
            url: string;
            format: string;
            auth: { apiKey?: string; headers?: Record<string, string> };
          }
        >;
      }
  >;
}

export interface EndpointsResponse {
  endpoints: Array<{
    name: string;
    url: string;
    format: string;
    auth: { apiKey?: string; headers?: Record<string, string> };
  }>;
}

export interface KnownModelsResponse {
  models: Array<{
    modelId: string;
    endpointName?: string;
    displayName?: string;
    contextSize?: number;
    capabilities?: Record<string, unknown>;
  }>;
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

export type ModelSelectionEntry =
  | string
  | {
      model: string;
      providerOptions?: Record<string, Record<string, unknown>>;
    };

export function entryToModelId(entry: ModelSelectionEntry): string {
  return typeof entry === 'string' ? entry : entry.model;
}

export interface ModelSelection {
  chat: ModelSelectionEntry[];
  compaction: ModelSelectionEntry[];
  memory: ModelSelectionEntry[];
  imageVision: ModelSelectionEntry[];
  audioListening: ModelSelectionEntry[];
  voice: { sts: string[]; tts: string[]; stt: string[] };
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
    options?: { method?: string; body?: unknown },
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: options?.method ?? 'GET',
      headers:
        options?.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : undefined,
      body:
        options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ error: response.statusText }));
      const message =
        (body as { error?: string }).error ?? `HTTP ${response.status}`;
      throw new AdminApiClientError(message, response.status);
    }

    return (await response.json()) as T;
  }

  // --- Providers ---

  getProviders(): Promise<ProviderResponse> {
    return this.request<ProviderResponse>('/v1/providers');
  }

  createProvider(body: unknown): Promise<ProviderResponse> {
    return this.request<ProviderResponse>('/v1/providers', {
      method: 'POST',
      body,
    });
  }

  updateProvider(name: string, body: unknown): Promise<ProviderResponse> {
    return this.request<ProviderResponse>(
      `/v1/providers/${encodeURIComponent(name)}`,
      { method: 'PATCH', body },
    );
  }

  deleteProvider(name: string): Promise<ProviderResponse> {
    return this.request<ProviderResponse>(
      `/v1/providers/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  }

  // --- Endpoints ---

  getEndpoints(providerName: string): Promise<EndpointsResponse> {
    return this.request<EndpointsResponse>(
      `/v1/providers/${encodeURIComponent(providerName)}/endpoints`,
    );
  }

  createEndpoint(
    providerName: string,
    body: unknown,
  ): Promise<EndpointsResponse> {
    return this.request<EndpointsResponse>(
      `/v1/providers/${encodeURIComponent(providerName)}/endpoints`,
      { method: 'POST', body },
    );
  }

  updateEndpoint(
    providerName: string,
    endpointName: string,
    body: unknown,
  ): Promise<EndpointsResponse> {
    return this.request<EndpointsResponse>(
      `/v1/providers/${encodeURIComponent(providerName)}/endpoints/${encodeURIComponent(endpointName)}`,
      { method: 'PATCH', body },
    );
  }

  deleteEndpoint(
    providerName: string,
    endpointName: string,
  ): Promise<EndpointsResponse> {
    return this.request<EndpointsResponse>(
      `/v1/providers/${encodeURIComponent(providerName)}/endpoints/${encodeURIComponent(endpointName)}`,
      { method: 'DELETE' },
    );
  }

  // --- Known Models ---

  getKnownModels(
    providerName: string,
    endpointName?: string,
  ): Promise<KnownModelsResponse> {
    const query = endpointName
      ? `?endpointName=${encodeURIComponent(endpointName)}`
      : '';
    return this.request<KnownModelsResponse>(
      `/v1/providers/${encodeURIComponent(providerName)}/known-models${query}`,
    );
  }

  createKnownModel(
    providerName: string,
    body: unknown,
  ): Promise<KnownModelsResponse> {
    return this.request<KnownModelsResponse>(
      `/v1/providers/${encodeURIComponent(providerName)}/known-models`,
      { method: 'POST', body },
    );
  }

  updateKnownModel(
    providerName: string,
    modelId: string,
    body: unknown,
    endpointName?: string,
  ): Promise<KnownModelsResponse> {
    const query = endpointName
      ? `?endpointName=${encodeURIComponent(endpointName)}`
      : '';
    return this.request<KnownModelsResponse>(
      `/v1/providers/${encodeURIComponent(providerName)}/known-models/${encodeURIComponent(modelId)}${query}`,
      { method: 'PATCH', body },
    );
  }

  deleteKnownModel(
    providerName: string,
    modelId: string,
    endpointName?: string,
  ): Promise<KnownModelsResponse> {
    const query = endpointName
      ? `?endpointName=${encodeURIComponent(endpointName)}`
      : '';
    return this.request<KnownModelsResponse>(
      `/v1/providers/${encodeURIComponent(providerName)}/known-models/${encodeURIComponent(modelId)}${query}`,
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

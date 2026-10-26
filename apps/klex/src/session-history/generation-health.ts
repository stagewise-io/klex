import { APICallError, NoOutputGeneratedError } from 'ai';

export type GenerationFailureCategory =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'connectivity'
  | 'configuration'
  | 'request_rejected'
  | 'server_error'
  | 'unknown';

export interface GenerationFailure {
  category: GenerationFailureCategory;
  reason: string;
  message: string;
  providerId: string | null;
  providerType: string | null;
  modelId: string | null;
  statusCode: number | null;
}

export interface GenerationHealthError extends GenerationFailure {
  kind: 'turn_failed' | 'request_rejected' | 'terminated';
  consecutiveFailures: number;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

const summaries: Record<GenerationFailureCategory, string> = {
  rate_limit:
    'Provider rate limit reached. Reduce request/token volume or increase TPM/RPM limits.',
  quota:
    'Provider quota or billing allowance exhausted. Check billing and quota limits.',
  auth: 'Provider authentication failed. Check the configured credentials and permissions.',
  connectivity:
    'Provider connection failed or timed out. Check connectivity and retry.',
  configuration:
    'Model configuration is unavailable or unsupported. Check the provider and model selection.',
  request_rejected:
    'Provider rejected the request. Check model input support and request limits.',
  server_error:
    'Provider server failed. Retry later or configure another provider.',
  unknown: 'Generation failed. Check agent logs and provider availability.',
};

/** Configured identifiers are bounded and never carry credentials or URLs. */
function safeIdentifier(value?: string | null): string | null {
  if (
    !value ||
    value.length > 128 ||
    !/^[a-zA-Z0-9_./:-]+$/.test(value) ||
    /sk-|AIza|bearer|:\/\/|www\./i.test(value)
  )
    return null;
  return value;
}

/**
 * Never persist provider prose: it can echo arbitrary prompts and payloads.
 * Translate it into an allowlisted actionable summary and numeric TPM/RPM
 * limits only. Do not inspect request bodies, headers, URLs or response bodies.
 */
export function summarizeGenerationFailure(
  error: unknown,
  context?: {
    providerId?: string | null;
    providerType?: string | null;
    modelId?: string | null;
  },
  classificationReason = '',
): GenerationFailure {
  for (
    let depth = 0;
    depth < 5 &&
    NoOutputGeneratedError.isInstance(error) &&
    error.cause != null;
    depth++
  ) {
    error = error.cause;
  }
  const statusCode = APICallError.isInstance(error)
    ? (error.statusCode ?? null)
    : null;
  const text =
    `${classificationReason} ${error instanceof Error ? error.message : typeof error === 'string' ? error : ''}`
      .slice(0, 16384)
      .toLowerCase();
  let category: GenerationFailureCategory = 'unknown';
  if (
    /insufficient_quota|billing|credit|quota.*(?:exhaust|exceed)|exceed.*quota|resource_exhausted/.test(
      text,
    )
  )
    category = 'quota';
  if (
    (statusCode === 429 && category !== 'quota') ||
    (/\btpm\b|\brpm\b|per.minute|rate.limit/.test(text) &&
      !/billing|insufficient_quota|credit/.test(text))
  )
    category = 'rate_limit';
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /api key|authentication/.test(text)
  )
    category = 'auth';
  else if (
    statusCode === 404 ||
    /no such model|unsupported|configuration|invalid prompt|transformer/.test(
      text,
    )
  )
    category = 'configuration';
  else if (
    statusCode === 408 ||
    /timeout|timed out|network|econn|fetch failed|socket hang up/.test(text)
  )
    category = 'connectivity';
  else if (statusCode !== null && statusCode >= 500) category = 'server_error';
  else if (statusCode !== null && statusCode >= 400 && statusCode !== 429)
    category = 'request_rejected';
  const labels: Record<GenerationFailureCategory, string> = {
    rate_limit: 'rate limited',
    quota: 'quota exhausted',
    auth: 'authentication error',
    connectivity: 'connection error',
    configuration: 'configuration error',
    request_rejected: 'request rejected',
    server_error: 'server error',
    unknown: 'generation error',
  };
  const limits = [
    ...text.matchAll(
      /\b(tpm|rpm|tokens per minute|requests per minute)\)?\s*[:=]?\s*(?:limit\s*[:=]?\s*)?(\d{1,9})\b/g,
    ),
  ]
    .slice(0, 4)
    .map((match) => `${match[1]?.toUpperCase()}: ${match[2]}`);
  return {
    category,
    reason: `${labels[category]}${statusCode === null ? '' : ` (${statusCode})`}`,
    message: [summaries[category], ...limits].join(' ').slice(0, 512),
    providerId: safeIdentifier(context?.providerId),
    providerType: safeIdentifier(context?.providerType),
    modelId: safeIdentifier(context?.modelId),
    statusCode,
  };
}

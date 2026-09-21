const SAFE_SPAN_ATTRIBUTES = new Set([
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.max_tokens',
  'gen_ai.request.temperature',
  'gen_ai.response.finish_reasons',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read_input_tokens',
  'gen_ai.usage.cache_creation_input_tokens',
  'gen_ai.usage.reasoning_tokens',
  'gen_ai.server.time_to_first_token',
  'gen_ai.response.finish_reason',
  'klex.operation.name',
  'klex.outcome',
  'klex.error.category',
  'klex.error.type',
  'klex.retryable',
]);

export function isAllowedTelemetryAttribute(name: string): boolean {
  return SAFE_SPAN_ATTRIBUTES.has(name);
}

export function isTelemetryContentAttribute(name: string): boolean {
  return /(?:^|[._-])(?:prompt|completion|system|tool|arguments?|results?|messages?|contents?|headers?)(?:$|[._-])/i.test(
    name,
  );
}

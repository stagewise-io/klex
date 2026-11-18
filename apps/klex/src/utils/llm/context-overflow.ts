const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Provider wording for a request whose input exceeds the model's context
 * window (OpenAI, Azure, Anthropic, Gemini, OpenAI-compatible servers).
 * Rate limits use 429 and are excluded by status.
 */
const CONTEXT_OVERFLOW_PATTERN =
  /context_length_exceeded|exceeds? the (?:model's )?(?:maximum )?context (?:window|length)|maximum context length|context window (?:of this model )?(?:is )?exceeded|prompt is too long|input is too long for|input token count .{0,40}exceeds the maximum/i;

/**
 * True when a generation error says the request did not fit the model's
 * context window. Only the error message, response body and error code are
 * inspected, recursively through `cause` and `lastError`.
 */
export function isContextOverflowError(error: unknown): boolean {
  const seen = new Set<unknown>();
  function visit(value: unknown, depth: number): boolean {
    if (depth > 10 || seen.has(value)) return false;
    seen.add(value);
    if (typeof value === 'string') return CONTEXT_OVERFLOW_PATTERN.test(value);
    if (!isRecord(value)) return false;
    if (value.statusCode === 429) return false;
    for (const text of [value.message, value.responseBody, value.code]) {
      if (typeof text === 'string' && CONTEXT_OVERFLOW_PATTERN.test(text))
        return true;
    }
    return (
      visit(value.error, depth + 1) ||
      visit(value.data, depth + 1) ||
      visit(value.lastError, depth + 1) ||
      visit(value.cause, depth + 1)
    );
  }
  return visit(error, 0);
}

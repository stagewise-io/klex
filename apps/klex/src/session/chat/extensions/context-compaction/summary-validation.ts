/**
 * Reject empty/error/control envelopes and obvious first-person non-answers before they
 * replace active history. This is a conservative guard, not a semantic quality
 * judge: quoted refusals and refusals reported inside a summary remain facts.
 */
export function summaryRejectionReason(
  text: string,
): 'empty' | 'error' | 'control-envelope' | 'refusal' | null {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  const unfenced = trimmed.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  try {
    const value: unknown = JSON.parse(unfenced);
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (Object.hasOwn(value, 'error') || Object.hasOwn(value, 'refusal'))
    )
      return 'error';
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const envelope = value as Record<string, unknown>;
      const keys = Object.keys(envelope);
      // Observed audio-model control replies contain no replacement narrative.
      // Do not reject a historical status/reference embedded in real prose or
      // in a JSON object with additional summary content.
      if (
        (keys.length === 1 &&
          typeof envelope.status === 'string' &&
          /^(?:denied|refused|rejected)$/i.test(envelope.status)) ||
        (keys.length === 2 &&
          typeof envelope.ref === 'string' &&
          typeof envelope.view === 'string')
      )
        return 'control-envelope';
    }
  } catch {
    // Summaries are normally plain text, not JSON.
  }
  const normalized = trimmed
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\bi'm\b/gi, 'I am');
  return /^(?:(?:i am sorry|i apologize|sorry|unfortunately)[\s,.!:—-]*(?:but\s+)?)?i\s+(?:cannot|can't|can not|am unable to|am not able to|won't|will not)\s+(?:help|assist|comply|fulfill|provide|identify|analy[sz]e|process|access|summari[sz]e|transcribe|describe)\b/i.test(
    normalized,
  )
    ? 'refusal'
    : null;
}

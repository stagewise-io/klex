// Known credential shapes. Prompt rules alone do not keep tokens out of durable memory.
const SECRET_PATTERN = new RegExp(
  [
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bxox[abp]-[A-Za-z0-9-]{10,}`,
    String.raw`\bsk-[A-Za-z0-9_-]{20,}`,
    String.raw`\b[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9._~+/=-]{20,}`,
    // AWS access key IDs, and 40-character secrets next to their usual labels.
    String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`,
    String.raw`(?:aws_?secret(?:_access)?_?key|secretAccessKey)\W{0,4}[A-Za-z0-9/+=]{40}\b`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  ].join('|'),
  'g',
);

// Any unbroken letter+digit run this long is machine-made: tokens, keys,
// hashes. Separators split runs, so `CLOUD-11682`, UUIDs and Slack IDs pass.
const RANDOM_RUN = /[A-Za-z0-9]{20,}/g;
const isRandom = (run: string) =>
  (run.match(/[0-9]/g)?.length ?? 0) >= 2 &&
  (run.match(/[A-Za-z]/g)?.length ?? 0) >= 2;

/** Replaces known credential shapes with `[secret]`. */
export function maskSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[secret]');
}

/**
 * Throws when a write contains a credential; never echoes it. Known shapes are
 * checked everywhere; the generic check covers only `prose` (fact text, skill
 * content), never identities, matchers or citations.
 */
export function rejectSecrets(value: unknown, prose: readonly string[]): void {
  if ((JSON.stringify(value) ?? '').match(SECRET_PATTERN))
    throw new Error('Input contains a credential; never store secrets');
  if (prose.some((text) => text.match(RANDOM_RUN)?.some(isRandom)))
    throw new Error(
      'Text contains a long random string (token, key or hash); describe it instead, put identifiers in LinkedIdentities',
    );
}

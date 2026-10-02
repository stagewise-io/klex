/** Projection for observability/durable memory only; never for model input. */
export function redactAttachmentSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string')
      return entry.replace(/https:\/\/[^\s<>"']+/gi, '[redacted-url]');
    if (!entry || typeof entry !== 'object') return entry;
    if (seen.has(entry)) return '[circular]';
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map(visit);
    const record = entry as Record<string, unknown>;
    const media = [
      'image',
      'image-data',
      'audio',
      'file',
      'file-data',
    ].includes(String(record.type));
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        (media && ['data', 'image', 'url'].includes(key)) ||
        (key === 'input' &&
          (record.toolName === 'readAttachment' ||
            record.type === 'tool-readAttachment'))
          ? '[redacted]'
          : visit(item),
      ]),
    );
  };
  return visit(value);
}

import type { JSONValue } from '@ai-sdk/provider';

/** Default ceiling for one tool result entering the model conversation. */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 256 * 1024;

export function serializedJsonBytes(value: JSONValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function exceedsToolResultLimit(
  value: JSONValue,
  maximumBytes: number,
): boolean {
  return serializedJsonBytes(value) > maximumBytes;
}

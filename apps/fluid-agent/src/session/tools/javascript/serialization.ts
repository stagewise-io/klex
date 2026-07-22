import type { JsonValue } from '@/tool-provider';

export class SerializationError extends Error {
  override readonly name = 'SerializationError';
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
}

export function serializedSize(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function assertSerializedSize(
  value: JsonValue,
  maximumBytes: number,
  label: string,
): void {
  const size = serializedSize(value);
  if (size > maximumBytes)
    throw new SerializationError(`${label} exceeds ${maximumBytes} bytes`);
}

export function toSerializedError(
  error: unknown,
  fallbackCode = 'JAVASCRIPT_SANDBOX_ERROR',
): SerializedError {
  if (error instanceof Error) {
    const code =
      'code' in error && typeof error.code === 'string'
        ? error.code
        : fallbackCode;
    return { name: error.name || 'Error', message: error.message, code };
  }
  return {
    name: 'Error',
    message: 'Unknown JavaScript sandbox error',
    code: fallbackCode,
  };
}

import { z } from 'zod';

declare const proxyExchangeIdBrand: unique symbol;

export type ProxyExchangeId = string & {
  readonly [proxyExchangeIdBrand]: true;
};

export const PROXY_PROTOCOL_VERSION = 2 as const;
export const MAX_PROXY_CHUNK_BYTES = 64 * 1024;

export type ProxyHeaders = Record<string, string>;

export interface ExchangeOpenFrame {
  readonly version: typeof PROXY_PROTOCOL_VERSION;
  readonly type: 'exchange.open';
  readonly exchangeId: ProxyExchangeId;
  readonly method: string;
  readonly url: string;
  readonly headers: ProxyHeaders;
  readonly body?: string;
}

export interface ExchangeOpenedFrame {
  readonly version: typeof PROXY_PROTOCOL_VERSION;
  readonly type: 'exchange.opened';
  readonly exchangeId: ProxyExchangeId;
  readonly status: number;
  readonly statusText: string;
  readonly headers: ProxyHeaders;
}

export interface ExchangeChunkFrame {
  readonly version: typeof PROXY_PROTOCOL_VERSION;
  readonly type: 'exchange.chunk';
  readonly exchangeId: ProxyExchangeId;
  readonly data: string;
}

export interface ExchangeCloseFrame {
  readonly version: typeof PROXY_PROTOCOL_VERSION;
  readonly type: 'exchange.close';
  readonly exchangeId: ProxyExchangeId;
  readonly reason?: string;
}

export type ProxyToEnvironmentFrame = ExchangeOpenFrame | ExchangeCloseFrame;
export type EnvironmentToProxyFrame =
  | ExchangeOpenedFrame
  | ExchangeChunkFrame
  | ExchangeCloseFrame;
export type ProxyFrame = ProxyToEnvironmentFrame | EnvironmentToProxyFrame;

const ProxyExchangeIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    'Exchange ID must not have whitespace',
  )
  .transform((value) => value as ProxyExchangeId);

const HeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .refine((value) => /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(value)),
    z.string().refine((value) => !/[\r\n]/.test(value)),
  )
  .transform((headers) => headers as ProxyHeaders);

const Base64Schema = z
  .string()
  .refine(isCanonicalBase64, 'Invalid base64 data');
const FrameBaseSchema = z.object({
  version: z.literal(PROXY_PROTOCOL_VERSION),
  exchangeId: ProxyExchangeIdSchema,
});
const ExchangeOpenFrameSchema = FrameBaseSchema.extend({
  type: z.literal('exchange.open'),
  method: z.string().regex(/^[A-Z]+$/),
  url: z.string().url(),
  headers: HeadersSchema,
  body: Base64Schema.optional(),
}).strict();
const ExchangeOpenedFrameSchema = FrameBaseSchema.extend({
  type: z.literal('exchange.opened'),
  status: z.number().int().min(100).max(599),
  statusText: z.string().refine((value) => !/[\r\n]/.test(value)),
  headers: HeadersSchema,
}).strict();
const ExchangeChunkFrameSchema = FrameBaseSchema.extend({
  type: z.literal('exchange.chunk'),
  data: Base64Schema.refine(
    (value) => decodedBase64Length(value) <= MAX_PROXY_CHUNK_BYTES,
    'Proxy chunk exceeds size limit',
  ),
}).strict();
const ExchangeCloseFrameSchema = FrameBaseSchema.extend({
  type: z.literal('exchange.close'),
  reason: z.string().min(1).optional(),
}).strict();
const ProxyToEnvironmentFrameSchema = z.discriminatedUnion('type', [
  ExchangeOpenFrameSchema,
  ExchangeCloseFrameSchema,
]);
const EnvironmentToProxyFrameSchema = z.discriminatedUnion('type', [
  ExchangeOpenedFrameSchema,
  ExchangeChunkFrameSchema,
  ExchangeCloseFrameSchema,
]);

export function createProxyExchangeId(value: string): ProxyExchangeId {
  return ProxyExchangeIdSchema.parse(value);
}

export function encodeProxyFrame(frame: ProxyFrame): string {
  return JSON.stringify(frame);
}

export function decodeProxyToEnvironmentFrame(
  input: string,
): ProxyToEnvironmentFrame {
  return ProxyToEnvironmentFrameSchema.parse(JSON.parse(input));
}

export function decodeEnvironmentToProxyFrame(
  input: string,
): EnvironmentToProxyFrame {
  return EnvironmentToProxyFrameSchema.parse(JSON.parse(input));
}

function isCanonicalBase64(value: string): boolean {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

function decodedBase64Length(value: string): number {
  return (
    (value.length * 3) / 4 -
    (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  );
}

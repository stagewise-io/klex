import { z } from 'zod/v4';

import { AttioError } from './errors.js';
import type { Operation } from './tools.js';

const identitySchema = z.object({
  active: z.literal(true),
  scope: z.string(),
  client_id: z.string().min(1),
  workspace_id: z.uuid(),
  token_type: z.literal('Bearer'),
  exp: z.number().finite().nullable(),
});
export type Identity = z.infer<typeof identitySchema>;
export interface HttpOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}
export function retryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (value === null) return;
  const milliseconds = /^\d+(\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(milliseconds)
    ? Math.min(60_000, Math.max(0, milliseconds))
    : undefined;
}
export class AttioClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  constructor(options: HttpOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.jitter = options.jitter ?? Math.random;
  }
  private async request(
    url: string,
    init: RequestInit,
    read: boolean,
    beforeDispatch: () => Promise<void> = async () => {},
  ) {
    const deadline = this.now() + 15_000;
    for (let attempt = 0; ; attempt++) {
      await beforeDispatch();
      let failure: AttioError;
      try {
        const response = await this.fetcher(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(5000, deadline - this.now())),
          ),
        });
        if (!response.ok) {
          await response.body?.cancel();
          const status = response.status;
          failure =
            status === 401
              ? new AttioError('RECONNECT_REQUIRED')
              : status === 403
                ? new AttioError('PERMISSION_DENIED')
                : status === 404
                  ? new AttioError('NOT_FOUND')
                  : status === 409
                    ? new AttioError('CONFLICT')
                    : status === 429
                      ? new AttioError(
                          'RATE_LIMITED',
                          read,
                          retryAfter(
                            response.headers.get('retry-after'),
                            this.now(),
                          ),
                        )
                      : status >= 500
                        ? new AttioError(
                            read ? 'UNAVAILABLE' : 'WRITE_OUTCOME_UNKNOWN',
                            read,
                          )
                        : new AttioError('INVALID_INPUT');
        } else {
          const reader = response.body?.getReader();
          if (!reader)
            throw new AttioError(
              read ? 'UPSTREAM_ERROR' : 'WRITE_OUTCOME_UNKNOWN',
            );
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 1_048_576)
                throw new AttioError(
                  read ? 'UPSTREAM_ERROR' : 'WRITE_OUTCOME_UNKNOWN',
                );
              chunks.push(part.value);
            }
            try {
              return JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              ) as unknown;
            } catch {
              throw new AttioError(
                read ? 'UPSTREAM_ERROR' : 'WRITE_OUTCOME_UNKNOWN',
              );
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
      } catch (error) {
        failure =
          error instanceof AttioError
            ? error
            : new AttioError(
                read ? 'UNAVAILABLE' : 'WRITE_OUTCOME_UNKNOWN',
                read,
              );
      }
      const delay =
        failure.retryAfterMs ??
        Math.floor(100 * 2 ** attempt + this.jitter() * 100);
      if (
        !read ||
        !failure.retryable ||
        attempt >= 2 ||
        this.now() + delay >= deadline
      )
        throw failure;
      await this.sleep(delay);
    }
  }
  async exchange(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<string> {
    const result = await this.request(
      'https://app.attio.com/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      },
      false,
    );
    const token = z
      .object({
        access_token: z.string().min(1).max(16_384),
        token_type: z.string().regex(/^Bearer$/i),
      })
      .safeParse(result);
    if (!token.success) throw new AttioError('UPSTREAM_ERROR');
    return token.data.access_token;
  }
  async introspect(token: string): Promise<Identity> {
    const result = await this.request(
      'https://app.attio.com/oauth/introspect',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      true,
    );
    if (
      result &&
      typeof result === 'object' &&
      'active' in result &&
      result.active === false
    )
      throw new AttioError('RECONNECT_REQUIRED');
    const parsed = identitySchema.safeParse(result);
    if (!parsed.success) throw new AttioError('UPSTREAM_ERROR');
    return parsed.data;
  }
  async records(
    token: string,
    workspaceId: string,
    op: Operation,
    guard: () => Promise<void>,
  ) {
    let raw: unknown;
    try {
      raw = await this.request(
        `https://api.attio.com${op.path}`,
        {
          method: op.method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(op.body === undefined ? {} : { body: JSON.stringify(op.body) }),
        },
        op.read,
        guard,
      );
    } catch (error) {
      if (
        op.search &&
        error instanceof AttioError &&
        (error.code === 'NOT_FOUND' || error.code === 'PERMISSION_DENIED')
      )
        throw new AttioError('CAPABILITY_UNAVAILABLE');
      throw error;
    }
    const record = z.object({
      id: z.object({
        workspace_id: z.uuid(),
        object_id: z.uuid(),
        record_id: z.uuid(),
      }),
      ...(op.search
        ? {
            record_text: z.string(),
            object_slug: z.string(),
            record_image: z.string().nullable().optional(),
          }
        : {
            values: z.record(z.string(), z.json()),
            created_at: z.string().optional(),
            web_url: z.string().optional(),
          }),
    });
    const result = z
      .object({
        data: op.limit === undefined ? record : z.array(record).max(op.limit),
      })
      .safeParse(raw);
    if (!result.success)
      throw new AttioError(
        op.read ? 'UPSTREAM_ERROR' : 'WRITE_OUTCOME_UNKNOWN',
      );
    const records = Array.isArray(result.data.data)
      ? result.data.data
      : [result.data.data];
    if (records.some((item) => item.id.workspace_id !== workspaceId))
      throw new AttioError('RECONNECT_REQUIRED');
    return {
      data: result.data.data,
      ...(op.offset === undefined
        ? {}
        : {
            pagination: {
              offset: op.offset,
              limit: op.limit,
              returned: records.length,
              nextOffset:
                records.length === op.limit ? op.offset + records.length : null,
            },
          }),
    };
  }
}

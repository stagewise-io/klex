import type { ModelMessage } from 'ai';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedModel } from '../extension-api';
import { ATTACHMENT_MAX_BYTES, AttachmentError } from './attachment-fetch';
import { AttachmentReader } from './read-attachment';

const model: ResolvedModel = {
  modelId: 'test',
  contextSize: 10000,
  inputCapabilities: { image: {} },
};
const url = 'https://attachments.example/image?signature=SECRET';
const png = () =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
const options = { toolCallId: 'call-1', messages: [], context: {} };
const history = (output: unknown): ModelMessage[] => [
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolName: 'readAttachment',
        toolCallId: 'call-1',
        output: { type: 'json', value: output as never },
      },
    ],
  },
];

async function setup(
  overrides: Partial<ConstructorParameters<typeof AttachmentReader>[0]> = {},
) {
  const bytes = await png();
  const fetch = vi.fn().mockResolvedValue({ bytes, mimeType: 'image/png' });
  const reader = new AttachmentReader({
    authorize: () => true,
    fetch: overrides.fetch ?? fetch,
    ...overrides,
  });
  return {
    reader,
    fetch: overrides.fetch ?? fetch,
    execute: (input: unknown = { url }, selected = model) =>
      reader.tool(selected).execute!(input, options),
  };
}

afterEach(() => vi.useRealTimers());

describe('readAttachment', () => {
  it('fully decodes an image and projects provider content without bytes or URL in the result', async () => {
    const { reader, execute } = await setup();
    const output = await execute();
    expect(output).toMatchObject({ ok: true, mimeType: 'image/png' });
    expect(JSON.stringify(output)).not.toContain('SECRET');
    const projected = reader.project(history(output), model);
    expect(projected).toMatchObject([
      {
        content: [
          {
            output: {
              type: 'content',
              value: [
                { type: 'text' },
                { type: 'image-data', mediaType: 'image/png' },
              ],
            },
          },
        ],
      },
    ]);
    expect(history(output)[0]).not.toHaveProperty('data');
    expect(
      reader.project(history(output), { ...model, inputCapabilities: {} }),
    ).toMatchObject([
      {
        content: [
          { output: { value: { error: { code: 'unsupported-provider' } } } },
        ],
      },
    ]);
    reader.clear();
    expect(reader.project(history(output), model)).toMatchObject([
      { content: [{ output: { value: { error: { code: 'fetch-failed' } } } }] },
    ]);
  });

  it.each(['image/jpeg', 'image/webp'])(
    'decodes supported %s',
    async (mimeType) => {
      const bytes = await (mimeType === 'image/jpeg'
        ? sharp(await png()).jpeg()
        : sharp(await png()).webp()
      ).toBuffer();
      const { execute } = await setup({
        fetch: vi.fn().mockResolvedValue({ bytes, mimeType }),
      });
      expect(await execute({ url, mimeType })).toMatchObject({ ok: true });
    },
  );

  it.each([
    [{ url: 'not a URL' }, 'invalid-input'],
    [{ url: 'http://example.com/a' }, 'ssrf-rejected'],
    [{ url, mimeType: 'application/pdf' }, 'unsupported-media'],
    [{ url, mimeType: 'video/mp4' }, 'unsupported-media'],
    [{ url, mimeType: 'audio/mpeg' }, 'unsupported-media'],
    [{ url, size: ATTACHMENT_MAX_BYTES + 1 }, 'too-large'],
    [{ url, maxPages: 1000 }, 'invalid-input'],
  ])(
    'rejects invalid/unsupported input before fetch: %j',
    async (input, code) => {
      const { execute, fetch } = await setup();
      expect(await execute(input)).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('requires authorization and provider image support before fetch', async () => {
    const denied = await setup({ authorize: () => false });
    expect(await denied.execute()).toMatchObject({
      error: { code: 'unauthorized' },
    });
    expect(denied.fetch).not.toHaveBeenCalled();
    const unsupported = await setup();
    expect(
      await unsupported.execute({ url }, { ...model, inputCapabilities: {} }),
    ).toMatchObject({ error: { code: 'unsupported-provider' } });
    expect(unsupported.fetch).not.toHaveBeenCalled();
  });

  it.each(['fetch-failed', 'ssrf-rejected', 'too-large', 'timeout'] as const)(
    'sanitizes %s',
    async (code) => {
      const { execute } = await setup({
        fetch: vi.fn().mockRejectedValue(new AttachmentError(code)),
      });
      expect(await execute()).toEqual({
        ok: false,
        error: { code, message: `Attachment unavailable: ${code}.` },
      });
    },
  );

  it('sanitizes unknown fetch exceptions', async () => {
    const { execute } = await setup({
      fetch: vi.fn().mockRejectedValue(new Error(url)),
    });
    expect(await execute()).toMatchObject({ error: { code: 'fetch-failed' } });
  });

  it('rejects sniff/header mismatch, disguised PDF and truncated images', async () => {
    for (const response of [
      { bytes: await png(), mimeType: 'text/html' },
      { bytes: await png(), mimeType: 'image/jpeg' },
      { bytes: Buffer.from('%PDF-1.7'), mimeType: 'application/pdf' },
    ]) {
      const { execute } = await setup({
        fetch: vi.fn().mockResolvedValue(response),
      });
      expect(await execute()).toMatchObject({
        error: { code: 'unsupported-media' },
      });
    }
    const { execute } = await setup({
      fetch: vi.fn().mockResolvedValue({
        bytes: (await png()).subarray(0, 25),
        mimeType: 'image/png',
      }),
    });
    expect(await execute()).toMatchObject({
      error: { code: 'conversion-failed' },
    });
  });

  it('bounds DNS/fetch stalls and does not retain a late result', async () => {
    const bytes = await png();
    let complete!: (value: { bytes: Buffer; mimeType: string }) => void;
    let completeNext!: (value: { bytes: Buffer; mimeType: string }) => void;
    const { execute, reader, fetch } = await setup({
      fetch: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              completeNext = resolve;
            }),
        ),
    });
    vi.useFakeTimers();
    const pending = execute();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({ error: { code: 'timeout' } });
    const next = reader.tool(model).execute!(
      { url },
      { ...options, toolCallId: 'next' },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    complete({ bytes, mimeType: 'image/png' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await execute()).toMatchObject({ error: { code: 'too-large' } });
    expect(reader.project(history({ ok: true }), model)).toMatchObject([
      { content: [{ output: { value: { ok: false } } }] },
    ]);
    completeNext({ bytes, mimeType: 'image/png' });
    expect(await next).toMatchObject({ ok: true });
  });

  it('cancels a fetch that ignores its signal and releases the slot immediately', async () => {
    const bytes = await png();
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ bytes, mimeType: 'image/png' });
    const { reader, execute } = await setup({ fetch });
    const controller = new AbortController();
    const pending = reader.tool(model).execute!(
      { url },
      { ...options, abortSignal: controller.signal },
    );
    controller.abort();
    expect(await pending).toMatchObject({ error: { code: 'timeout' } });
    expect(await execute()).toMatchObject({ ok: true });
  });

  it('cancels stalled decoding on shutdown and cannot publish its late completion', async () => {
    const bytes = await png();
    let complete!: (bytes: Buffer) => void;
    const decode = vi.fn(
      () =>
        new Promise<Buffer>((resolve) => {
          complete = resolve;
        }),
    );
    const { reader, execute } = await setup({ decode });
    const pending = execute();
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    reader.clear();
    expect(await pending).toMatchObject({ error: { code: 'timeout' } });
    complete(bytes);
    await Promise.resolve();
    expect(reader.project(history({ ok: true }), model)).toMatchObject([
      { content: [{ output: { value: { error: { code: 'fetch-failed' } } } }] },
    ]);
  });

  it.each([
    ['timeout', 'resolve'],
    ['timeout', 'reject'],
    ['cancel', 'resolve'],
    ['cancel', 'reject'],
  ])(
    'holds the decode slot after %s until late %s without publishing',
    async (cancellation, settlement) => {
      const bytes = await png();
      const late = Promise.withResolvers<Buffer>();
      const decode = vi
        .fn()
        .mockReturnValueOnce(late.promise)
        .mockResolvedValue(bytes);
      const { reader, execute, fetch } = await setup({ decode });
      const controller = new AbortController();
      vi.useFakeTimers();
      const pending = reader
        .tool(model)
        .execute?.({ url }, { ...options, abortSignal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(decode).toHaveBeenCalledOnce();
      if (cancellation === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
      else controller.abort();
      expect(await pending).toMatchObject({ error: { code: 'timeout' } });

      for (let retry = 0; retry < 3; retry++) {
        expect(await execute()).toMatchObject({ error: { code: 'too-large' } });
        await vi.advanceTimersByTimeAsync(10_001);
      }
      expect(fetch).toHaveBeenCalledOnce();
      expect(decode).toHaveBeenCalledOnce();

      if (settlement === 'resolve') late.resolve(bytes);
      else late.reject(new Error('late decode failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(reader.project(history({ ok: true }), model)).toMatchObject([
        {
          content: [{ output: { value: { error: { code: 'fetch-failed' } } } }],
        },
      ]);

      const output = await execute();
      expect(output).toMatchObject({ ok: true });
      expect(decode).toHaveBeenCalledTimes(2);
      expect(reader.project(history(output), model)).toMatchObject([
        { content: [{ output: { type: 'content' } }] },
      ]);
    },
  );

  it.each(['png', 'jpeg', 'webp'] as const)(
    'sniffs %s without a specific MIME type',
    async (format) => {
      const bytes = await sharp(await png())
        .toFormat(format)
        .toBuffer();
      for (const mimeType of ['', 'application/octet-stream']) {
        const { execute } = await setup({
          fetch: vi.fn().mockResolvedValue({ bytes, mimeType }),
        });
        expect(await execute({ url, mimeType })).toMatchObject({ ok: true });
      }
    },
  );

  it('fails before reporting success when decoded media cannot be projected', async () => {
    const { execute } = await setup({
      decode: vi.fn().mockResolvedValue(Buffer.from('not a PNG')),
    });
    expect(await execute()).toMatchObject({
      error: { code: 'conversion-failed' },
    });
    const realtime = await setup();
    expect(
      await realtime.execute({ url }, { ...model, ephemeralToolImages: false }),
    ).toMatchObject({ error: { code: 'unsupported-provider' } });
    expect(realtime.fetch).not.toHaveBeenCalled();
  });

  it('preserves text-only context exactly', async () => {
    const { reader } = await setup();
    const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];
    expect(reader.project(messages, model)).toEqual(messages);
  });

  it('respects provider byte limits and rejects oversized decoded output', async () => {
    const { execute } = await setup();
    expect(
      await execute(
        { url },
        { ...model, inputCapabilities: { image: { maxBytes: 1 } } },
      ),
    ).toMatchObject({ error: { code: 'too-large' } });
    const oversized = await setup({
      decode: vi.fn().mockResolvedValue(Buffer.alloc(ATTACHMENT_MAX_BYTES + 1)),
    });
    expect(await oversized.execute()).toMatchObject({
      error: { code: 'too-large' },
    });
  });

  it('expires media and never reprojects provider-error results', async () => {
    const { reader, execute } = await setup();
    const output = await execute();
    const failed = history({ ok: false, error: { code: 'provider-error' } });
    expect(reader.project(failed, model)).toEqual(failed);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(300_001);
    expect(reader.project(history(output), model)).toMatchObject([
      { content: [{ output: { value: { error: { code: 'fetch-failed' } } } }] },
    ]);
  });
});

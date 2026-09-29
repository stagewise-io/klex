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
    fetch,
    ...overrides,
  });
  return {
    reader,
    fetch,
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
    const { execute, reader } = await setup({
      fetch: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    vi.useFakeTimers();
    const pending = execute();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({ error: { code: 'timeout' } });
    expect(reader.project(history({ ok: false }), model)).toEqual(
      history({ ok: false }),
    );
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

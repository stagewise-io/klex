import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATTACHMENT_MAX_BYTES,
  fetchAttachment,
  isPublicAttachmentAddress,
  parseAttachmentUrl,
} from './attachment-fetch';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));

const url = new URL('https://attachments.example/file?sig=secret');
let response: PassThrough & {
  statusCode: number;
  headers: Record<string, string>;
};
let req: EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.mocked(lookup)
    .mockReset()
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  response = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { 'content-type': 'image/png' },
  });
  req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  vi.mocked(request)
    .mockReset()
    .mockImplementation(((
      _url: unknown,
      _options: unknown,
      callback: (response: unknown) => void,
    ) => {
      req.end.mockImplementation(() =>
        queueMicrotask(() => callback(response)),
      );
      return req;
    }) as never);
});

describe('attachment fetch security', () => {
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '3fff::1',
  ])('blocks %s', (address) => {
    expect(isPublicAttachmentAddress(address)).toBe(false);
  });
  it.each(['93.184.216.34', '2606:4700:4700::1111'])(
    'accepts public %s',
    (address) => {
      expect(isPublicAttachmentAddress(address)).toBe(true);
    },
  );
  it.each([
    'file:///tmp/a',
    'data:image/png;base64,a',
    'http://example.com/a',
    'https://user:secret@example.com/a',
    'https://example.com:8443/a',
    'https://example.com/a#fragment',
  ])('rejects URL %s', (value) => {
    expect(() => parseAttachmentUrl(value)).toThrow('ssrf-rejected');
  });
  it('rejects mixed public/private DNS answers without connecting', async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
    await expect(
      fetchAttachment(url, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'ssrf-rejected' });
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects normalized numeric loopback without DNS or request', async () => {
    await expect(
      fetchAttachment(
        parseAttachmentUrl('https://2130706433/a'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ssrf-rejected' });
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it('pins the checked IP for both Node lookup modes while retaining TLS hostname', async () => {
    const pending = fetchAttachment(url, new AbortController().signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    const [target, options] = vi.mocked(request).mock.calls[0]! as unknown as [
      URL,
      {
        agent: boolean;
        lookup: (
          host: string,
          options: { all: boolean },
          cb: (...args: unknown[]) => void,
        ) => void;
      },
    ];
    expect(target.hostname).toBe('attachments.example');
    expect(options.agent).toBe(false);
    vi.mocked(lookup).mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
    ] as never);
    const cb = vi.fn();
    options.lookup(target.hostname, { all: true }, cb);
    expect(cb).toHaveBeenLastCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
    ]);
    options.lookup(target.hostname, { all: false }, cb);
    expect(cb).toHaveBeenLastCalledWith(null, '93.184.216.34', 4);
    response.end('image');
    expect(await pending).toEqual({
      bytes: Buffer.from('image'),
      mimeType: 'image/png',
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it.each([302, 401, 404, 500])(
    'rejects status %s without following redirects',
    async (status) => {
      response.statusCode = status;
      const pending = fetchAttachment(url, new AbortController().signal);
      await expect(pending).rejects.toMatchObject({ code: 'fetch-failed' });
      expect(request).toHaveBeenCalledTimes(1);
      expect(req.destroy).toHaveBeenCalled();
    },
  );
  it('rejects declared oversize', async () => {
    response.headers['content-length'] = String(ATTACHMENT_MAX_BYTES + 1);
    await expect(
      fetchAttachment(url, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'too-large' });
  });
  it('rejects compressed responses', async () => {
    response.headers['content-encoding'] = 'gzip';
    await expect(
      fetchAttachment(url, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unsupported-media' });
  });
  it('limits a chunked body independently of headers', async () => {
    const pending = fetchAttachment(url, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'too-large',
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    response.write(Buffer.alloc(ATTACHMENT_MAX_BYTES));
    response.write(Buffer.from('!'));
    await assertion;
    expect(response.destroyed).toBe(true);
  });
  it('sanitizes network errors', async () => {
    const pending = fetchAttachment(url, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'fetch-failed',
      message: 'fetch-failed',
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    req.emit('error', new Error(url.href));
    await assertion;
  });
});

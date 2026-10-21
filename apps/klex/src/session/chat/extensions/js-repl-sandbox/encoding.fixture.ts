export const encodingCases = [
  {
    name: 'typed-array base64 and hex conversions',
    code: `return { base64: Uint8Array.fromBase64('aGVsbG8=').toBase64(),
      hex: Uint8Array.fromHex('00aBff').toHex(),
      decoded: new TextDecoder().decode(Uint8Array.fromBase64('aGVsbG8=')) };`,
    expected: { base64: 'aGVsbG8=', hex: '00abff', decoded: 'hello' },
  },
  {
    name: 'URL and separate URLSearchParams',
    code: `const url = new URL('/path?q=hello+world#part', 'https://example.com:8443');
      const params = new URLSearchParams(url.search);
      params.append('q', 'second');
      return { href: url.href, origin: url.origin, protocol: url.protocol,
        hostname: url.hostname, port: url.port, pathname: url.pathname,
        search: url.search, hash: url.hash, values: params.getAll('q') };`,
    expected: {
      href: 'https://example.com:8443/path?q=hello+world#part',
      origin: 'https://example.com:8443',
      protocol: 'https:',
      hostname: 'example.com',
      port: '8443',
      pathname: '/path',
      search: '?q=hello+world',
      hash: '#part',
      values: ['hello world', 'second'],
    },
  },
  {
    name: 'crypto UUID, random bytes, and SHA-256',
    code: `const bytes = new Uint8Array(8);
      const random = crypto.getRandomValues(bytes);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
      return { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()),
        sameArray: random === bytes, length: random.length,
        digest: new Uint8Array(digest).toHex() };`,
    expected: {
      uuid: true,
      sameArray: true,
      length: 8,
      digest:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
  },
  {
    name: 'independent structured clones of nested objects and arrays',
    code: `const original = { nested: [{ value: 1 }] };
      const copy = structuredClone(original);
      copy.nested[0].value = 2;
      return { original, copy };`,
    expected: {
      original: { nested: [{ value: 1 }] },
      copy: { nested: [{ value: 2 }] },
    },
  },
  {
    name: 'case-insensitive Headers',
    code: `return new Headers({ 'Content-Type': 'application/json' }).get('content-type');`,
    expected: 'application/json',
  },
  {
    name: 'multi-byte UTF-8 round-trip',
    code: `return new TextDecoder().decode(new TextEncoder().encode('héllo 🌍'));`,
    expected: 'héllo 🌍',
  },
  {
    name: 'encodeInto with a partial multi-byte destination',
    code: `const bytes = new Uint8Array(5);
      const result = new TextEncoder().encodeInto('é🌍', bytes);
      return { ...result, bytes: Array.from(bytes) };`,
    expected: { read: 1, written: 2, bytes: [195, 169, 0, 0, 0] },
  },
  {
    name: 'base64 round-trip',
    code: `return { encoded: btoa('hello'), decoded: atob(btoa('héllo')) };`,
    expected: { encoded: 'aGVsbG8=', decoded: 'héllo' },
  },
];

export const encodingErrors = [
  {
    code: `new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([255]));`,
    name: 'TypeError',
  },
  { code: `atob('!');`, name: 'InvalidCharacterError' },
  { code: `btoa('🌍');`, name: 'InvalidCharacterError' },
];

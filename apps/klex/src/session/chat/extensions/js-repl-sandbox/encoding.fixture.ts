export const encodingCases = [
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
];

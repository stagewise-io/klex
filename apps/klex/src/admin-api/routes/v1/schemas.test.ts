import { describe, expect, it } from 'vitest';

import { createGodMessageBodySchema } from './schemas';

describe('createGodMessageBodySchema', () => {
  it('rejects empty text and invalid base64 content', () => {
    expect(
      createGodMessageBodySchema.safeParse({
        content: [{ type: 'text', text: '' }],
      }).success,
    ).toBe(false);
    expect(
      createGodMessageBodySchema.safeParse({
        content: [{ type: 'image', mimeType: 'image/png', data: 'not base64' }],
      }).success,
    ).toBe(false);
  });

  it('requires exactly one resource content representation', () => {
    const resource = { uri: 'file:///message.txt' };

    expect(
      createGodMessageBodySchema.safeParse({
        content: [{ type: 'resource', resource }],
      }).success,
    ).toBe(false);
    expect(
      createGodMessageBodySchema.safeParse({
        content: [
          {
            type: 'resource',
            resource: { ...resource, text: 'hello', blob: 'aGVsbG8=' },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      createGodMessageBodySchema.safeParse({
        content: [
          { type: 'resource', resource: { ...resource, text: 'hello' } },
        ],
      }).success,
    ).toBe(true);
  });

  it('bounds the number and size of retained content blocks', () => {
    expect(
      createGodMessageBodySchema.safeParse({
        content: Array.from({ length: 17 }, () => ({
          type: 'text',
          text: 'x',
        })),
      }).success,
    ).toBe(false);
    expect(
      createGodMessageBodySchema.safeParse({
        content: [{ type: 'text', text: 'x'.repeat(100_001) }],
      }).success,
    ).toBe(false);
  });
});

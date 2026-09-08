import { describe, expect, it } from 'vitest';

import { createGodMessageBodySchema, modelCapabilitiesSchema } from './schemas';

describe('modelCapabilitiesSchema', () => {
  it('preserves provider-independent image and audio limits', () => {
    const capabilities = {
      input: {
        image: {
          mediaTypes: ['image/png'],
          maxBytes: 10_000,
          maxWidth: 2048,
          maxHeight: 2048,
          maxTotalPixels: 4_194_304,
        },
        audio: {
          mediaTypes: ['audio/wav'],
          maxBytes: 20_000,
          maxLengthSeconds: 60,
        },
      },
      voice: { sts: true, tts: true, stt: true },
      tools: true,
      reasoning: true,
    };

    expect(modelCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
  });
});

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

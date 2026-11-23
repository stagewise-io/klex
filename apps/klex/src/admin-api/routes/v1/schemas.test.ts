import { describe, expect, it } from 'vitest';

import { modelCapabilitiesSchema } from './schemas';

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

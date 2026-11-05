import type { FilePart, ImagePart, ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { adaptContent } from '../content-adaptation/content-adaptation';
import { makeDeps, makeModel, runTransformer } from './test-helpers';
import { UNSUPPORTED_IMAGE_TEXT } from './vision-helper';

describe('image reference adaptation', () => {
  const model = makeModel({
    reference: { providerId: 'openai', modelId: 'test' },
    inputCapabilities: { image: { mediaTypes: ['image/jpeg'] } },
  });
  const reference = { openai: 'file-123' };

  it.each<FilePart | ImagePart>([
    { type: 'file', data: reference, mediaType: 'image/jpeg' },
    { type: 'file', data: reference, mediaType: 'image/jpg; quality=90' },
    { type: 'image', image: reference, mediaType: 'image/jpg' },
  ])('preserves supported provider references: %j', async (part) => {
    const deps = makeDeps();
    const history: ModelMessage[] = [{ role: 'user', content: [part] }];
    const before = structuredClone(history);
    const expected = [
      { role: 'user', content: [{ ...part, mediaType: 'image/jpeg' }] },
    ];

    expect(await runTransformer(history, model, deps)).toEqual(expected);
    expect(await adaptContent(history, deps, model)).toEqual(expected);
    expect(deps.modelResolver.getLanguageModel).not.toHaveBeenCalled();
    expect(history).toEqual(before);
  });

  it.each([
    { data: reference, mediaType: 'image/png', accepted: false },
    {
      data: new URL('https://allowed.example/image.jpg'),
      mediaType: 'image/jpeg',
      accepted: true,
    },
    {
      data: new URL('https://unsupported.example/image.jpg'),
      mediaType: 'image/jpeg',
      accepted: false,
    },
    {
      data: new URL('ftp://allowed.example/image.jpg'),
      mediaType: 'image/jpeg',
      accepted: false,
    },
  ])(
    'validates media types and URL support: %j',
    async ({ data, mediaType, accepted }) => {
      const deps = makeDeps();
      deps.modelResolver.getLanguageModel = vi.fn().mockReturnValue({
        supportedUrls: { 'image/jpeg': [/^https:\/\/allowed\.example\//] },
      });
      const part: FilePart = { type: 'file', data, mediaType };
      const history: ModelMessage[] = [{ role: 'user', content: [part] }];

      expect(await runTransformer(history, model, deps)).toEqual([
        {
          role: 'user',
          content: [
            accepted ? part : { type: 'text', text: UNSUPPORTED_IMAGE_TEXT },
          ],
        },
      ]);
      if (data instanceof URL) {
        expect(deps.modelResolver.getLanguageModel).toHaveBeenCalledWith(
          model.reference,
        );
      } else {
        expect(deps.modelResolver.getLanguageModel).not.toHaveBeenCalled();
      }
    },
  );
});

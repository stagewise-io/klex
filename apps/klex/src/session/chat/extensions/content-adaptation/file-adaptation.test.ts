import type { FilePart, ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { makeDeps, makeModel } from '../audio-input-optimizer/test-helpers';
import { adaptAudioContent, adaptContent } from './content-adaptation';
import { adaptFilePart, adaptRemoteMedia } from './file-adaptation';

const file = (data: unknown, mediaType = 'text/plain'): FilePart =>
  ({ type: 'file', mediaType, data }) as FilePart;

describe('historical attachment fallback', () => {
  it.each(['test', 'note: hello', 'data:text/plain,100%'])(
    'preserves plain text without clean base64 or URI decoding: %s',
    async (data) => {
      expect(
        await adaptFilePart(file(data), 'user', makeDeps(), makeModel(), false),
      ).toEqual({
        type: 'text',
        text: data.startsWith('data:') ? '100%' : data,
      });
    },
  );
  it.each([
    'hello world',
    'aGVsbG8gd29ybGQ=',
    'data:text/plain;base64,aGVsbG8gd29ybGQ=',
    new URL('data:text/plain,hello%20world'),
    { type: 'url', url: new URL('data:text/plain,hello%20world') },
    { type: 'text', text: 'hello world' },
    { type: 'data', data: new TextEncoder().encode('hello world') },
    new TextEncoder().encode('hello world'),
    new TextEncoder().encode('hello world').buffer,
  ])('decodes inline text representation %#', async (data) => {
    expect(
      await adaptFilePart(
        file(data, 'Text/Plain; charset=utf-8'),
        'user',
        makeDeps(),
        makeModel(),
        false,
      ),
    ).toEqual({ type: 'text', text: 'hello world' });
  });

  it.each([
    'application/json',
    'application/problem+json',
    'application/xml',
    'application/atom+xml',
    'application/yaml',
    'text/csv',
  ])('inlines %s', async (mediaType) => {
    expect(
      await adaptFilePart(
        file('hello world', mediaType),
        'user',
        makeDeps(),
        makeModel(),
        false,
      ),
    ).toEqual({ type: 'text', text: 'hello world' });
  });

  it('does not emit undecodable binary or remote text as inline text', async () => {
    for (const data of [
      new Uint8Array([0, 255]),
      '',
      'https://example.com/private.txt',
    ]) {
      const result = await adaptFilePart(
        file(data),
        'user',
        makeDeps(),
        makeModel(),
        false,
      );
      expect(result.type).toBe('text');
      expect(result).not.toEqual({ type: 'text', text: data });
    }
  });

  it('projects all roles and tool representations without mutating history', async () => {
    const history = [
      { role: 'user', content: [file('hello world')] },
      {
        role: 'assistant',
        content: [
          file(
            { type: 'text', text: 'hello world' },
            'application/octet-stream',
          ),
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'other',
            toolCallId: '1',
            output: {
              type: 'content',
              value: [
                {
                  type: 'file-data',
                  mediaType: 'text/plain',
                  data: 'aGVsbG8gd29ybGQ=',
                },
                {
                  type: 'file-url',
                  mediaType: 'text/plain',
                  url: 'data:text/plain,hello%20world',
                },
                file({ type: 'text', text: 'hello world' }),
              ],
            },
          },
        ],
      },
    ] as ModelMessage[];
    const before = structuredClone(history);
    const result = await adaptAudioContent(history, makeDeps(), makeModel());
    expect(JSON.stringify(result).match(/hello world/g)).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain('"type":"file');
    expect(history).toEqual(before);
  });

  it('preserves inline user PDFs but removes assistant files and all compaction files', async () => {
    const pdf = file(new Uint8Array([1, 2, 3]), 'application/pdf');
    expect(
      await adaptFilePart(pdf, 'user', makeDeps(), makeModel(), false),
    ).toEqual(pdf);
    expect(
      (await adaptFilePart(pdf, 'assistant', makeDeps(), makeModel(), false))
        .type,
    ).toBe('text');
    const history = [
      { role: 'user', content: [pdf] },
      { role: 'assistant', content: [pdf] },
    ] as ModelMessage[];
    expect(
      JSON.stringify(await adaptContent(history, makeDeps(), makeModel())),
    ).not.toContain('"type":"file"');
  });

  it.each([
    'google-gemini',
    'google-generative',
    'google-vertex',
    'openai-compatible',
    'openai',
    'anthropic',
    'unknown',
    'amazon-bedrock',
  ])('gates inline video for %s', async (providerType) => {
    const deps = makeDeps();
    deps.modelResolver.resolveModel = vi.fn().mockReturnValue({ providerType });
    const model = makeModel({
      reference: { providerId: 'test', modelId: 'test' },
    });
    const result = await adaptFilePart(
      file(new Uint8Array([1, 2]), 'video/mp4'),
      'user',
      deps,
      model,
      false,
    );
    expect(result.type).toBe(
      ['openai', 'anthropic', 'unknown'].includes(providerType)
        ? 'text'
        : 'file',
    );
  });

  it('checks provider URL support and canonical media aliases', async () => {
    const deps = makeDeps();
    deps.modelResolver.getLanguageModel = vi.fn().mockReturnValue({
      supportedUrls: {
        'image/jpeg': [/^https:/],
        'application/pdf': [/^https:/],
      },
    });
    const model = makeModel({
      reference: { providerId: 'test', modelId: 'test' },
      inputCapabilities: {
        image: { mediaTypes: ['image/jpeg'] },
        audio: { mediaTypes: ['audio/wav'] },
      },
    });
    expect(
      await adaptRemoteMedia(
        file(new URL('https://example.com/a.jpg'), 'image/jpg'),
        deps,
        model,
        'image',
      ),
    ).toMatchObject({ mediaType: 'image/jpeg' });
    expect(
      await adaptRemoteMedia(
        file(new URL('https://example.com/a.png'), 'image/png'),
        deps,
        model,
        'image',
      ),
    ).toBeNull();
    expect(
      await adaptRemoteMedia(
        file(new URL('https://example.com/a.wav'), 'audio/wav'),
        deps,
        model,
        'audio',
      ),
    ).toBeNull();
    const pdf = file(new URL('https://example.com/a.pdf'), 'application/pdf');
    expect(await adaptFilePart(pdf, 'user', deps, model, false)).toEqual(pdf);
    expect(
      (await adaptFilePart(pdf, 'assistant', deps, model, false)).type,
    ).toBe('text');
    expect(
      (
        await adaptFilePart(
          file(new URL('https://example.com/a.txt')),
          'tool',
          deps,
          model,
          false,
        )
      ).type,
    ).toBe('text');
    const wav = file(new URL('https://example.com/a.wav'), 'audio/wav');
    expect(await adaptRemoteMedia(wav, deps, makeModel(), 'audio')).toEqual(
      wav,
    );
  });
});

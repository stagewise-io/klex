import { describe, expect, it } from 'vitest';

import { boundContext, limits } from './bounds';
import { catalog, compile } from './catalog';
import { createInputProjections } from './input-projections';

const service = createInputProjections();
describe('untrusted MCP size ceilings', () => {
  it('handles a source-owned omission marker without throwing', () => {
    const data = {
      _omitted: 'source',
      ...Object.fromEntries(
        Array.from({ length: 150 }, (_, i) => [`field${i}`, i]),
      ),
    };
    expect(() =>
      boundContext({ sourceEnv: 'test', metadata: { data }, content: [] }),
    ).not.toThrow();
  });
  it('keeps valid native media atomic but bounds embedded resource text', () => {
    const image = {
      type: 'image' as const,
      mimeType: 'image/png',
      data: 'AAAA'.repeat(20_000),
    };
    const result = boundContext({
      sourceEnv: 'test',
      metadata: {},
      content: [
        image,
        {
          type: 'resource',
          resource: { uri: 'test://resource', text: 'x'.repeat(20_000) },
        },
      ],
    });
    expect(result.content[0]).toEqual(image);
    expect(JSON.stringify(result.content[1]).length).toBeLessThan(
      limits.textBytes,
    );
  });
  it('preserves producer fields that match former control names', () => {
    const result = boundContext({
      sourceEnv: 'test',
      metadata: {
        data: { message: 'hello' },
        inputEventRef: 'abcdefgh',
        inputFiltered: true,
        inputFilterNote: 'filtered',
      },
      content: [],
    });
    expect(result.metadata).toEqual({
      data: { message: 'hello' },
      inputEventRef: 'abcdefgh',
      inputFiltered: true,
      inputFilterNote: 'filtered',
    });
  });
  it('marks multibyte source truncation as size-limited', () => {
    const result = boundContext({
      sourceEnv: '😀'.repeat(100),
      metadata: {},
      content: [],
    });
    expect(Buffer.byteLength(result.sourceEnv)).toBeLessThanOrEqual(128);
  });
  for (const field of [
    'message',
    'text',
    'replyTarget',
    'conversationId',
    'unknown',
  ]) {
    it(`bounds ${field} regardless of assignment or identity`, () => {
      const data = { [field]: '\u0000😀'.repeat(50_000) };
      const input = catalog(data);
      const plan = compile(input, {
        keep: input.fields.map(({ path }) => path),
      });
      const context = {
        sourceEnv: 'test',
        metadata: { origin: 'events', data },
        content: [],
      };
      for (const selection of [undefined, plan, { ...plan, identity: true }]) {
        const result = service.project(context, selection).context;
        expect(Buffer.byteLength(JSON.stringify(result.metadata))).toBeLessThan(
          limits.metadataBytes + 512,
        );
      }
      expect(context.metadata.data).toEqual(data);
    });
  }
  it('bounds many fields, hostile keys, native text and resource bodies together', () => {
    const context = {
      sourceEnv: 's'.repeat(20_000),
      metadata: {
        origin: 'push-notifications',
        data: Object.fromEntries(
          Array.from({ length: 300 }, (_, i) => [
            `message${i}`,
            'x'.repeat(10_000),
          ]),
        ),
        inputEventRef: 'spoofed1',
        inputFiltered: false,
        inputFilterNote: 'malicious',
      },
      content: Array.from({ length: 100 }, () => ({
        type: 'text' as const,
        text: 'x'.repeat(20_000),
      })),
    };
    const result = boundContext(context);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(14_000);
    expect(context.metadata.inputEventRef).toBe('spoofed1');
    expect(result.content.length).toBeLessThanOrEqual(limits.contentItems);
  });
});

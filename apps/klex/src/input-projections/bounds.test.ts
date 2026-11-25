import { describe, expect, it } from 'vitest';

import { boundContext, limits } from './bounds';
import { catalog, compile } from './catalog';
import { createInputProjections } from './input-projections';

const service = createInputProjections();
describe('untrusted MCP size ceilings', () => {
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
        assignments: input.fields.map(({ fieldId }) => ({
          fieldId,
          section: 'default',
        })),
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
        expect(result.metadata.inputPreviewLimited).toBe(true);
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
        moreInfoSections: ['malicious'],
      },
      content: Array.from({ length: 100 }, () => ({
        type: 'text' as const,
        text: 'x'.repeat(20_000),
      })),
    };
    const result = boundContext(context);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(14_000);
    expect(result.metadata.inputEventRef).toBeUndefined();
    expect(result.content.length).toBeLessThanOrEqual(limits.contentItems);
  });
  it('retains small atomic arrays without traversing their contents', () => {
    const data = { messages: [{ text: 'Help' }] };
    expect(
      boundContext({ sourceEnv: 'test', metadata: { data }, content: [] })
        .metadata.data,
    ).toEqual(data);
  });
});

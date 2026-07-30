import { describe, expect, it } from 'vitest';

import type { ContextDataUIPart } from '@/session/inbox';

import { createCoreDataPartsExt } from './core-data-parts';

describe('CoreDataPartsExt', () => {
  const ext = createCoreDataPartsExt.create({} as never);

  it('has the correct identifier', () => {
    expect(ext.identifier).toBe('io.stagewise/core-data-parts');
  });

  it('converts data-context to XML text with sourceEnv, metadata, and content', () => {
    const transformer = ext.dataPartTransformers?.context;
    expect(transformer).toBeDefined();

    const data: ContextDataUIPart = {
      sourceEnv: 'slack',
      metadata: { channel: 'general', priority: 1 },
      content: [{ type: 'text', text: 'hello' }],
    };
    const result = transformer!(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('text');
    expect(result[0]!.text).toContain('<context source-env="slack">');
    expect(result[0]!.text).toContain('<metadata>');
    expect(result[0]!.text).toContain('channel');
    expect(result[0]!.text).toContain('general');
    expect(result[0]!.text).toContain('priority');
    expect(result[0]!.text).toContain('1');
    expect(result[0]!.text).toContain('<content>hello</content>');
    expect(result[0]!.text).toContain('</context>');
  });

  it('joins multiple text content parts with spaces', () => {
    const transformer = ext.dataPartTransformers?.context;
    const data: ContextDataUIPart = {
      sourceEnv: 'email',
      metadata: {},
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    };
    const result = transformer!(data);
    expect(result[0]!.text).toContain('<content>first second</content>');
  });

  it('serializes boolean metadata values', () => {
    const transformer = ext.dataPartTransformers?.context;
    const data: ContextDataUIPart = {
      sourceEnv: 'webhook',
      metadata: { urgent: true },
      content: [{ type: 'text', text: 'alert' }],
    };
    const result = transformer!(data);
    expect(result[0]!.text).toContain('urgent');
    expect(result[0]!.text).toContain('true');
  });

  it('returns empty string for non-text content parts', () => {
    const transformer = ext.dataPartTransformers?.context;
    const data: ContextDataUIPart = {
      sourceEnv: 'media',
      metadata: {},
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          url: 'https://example.com/img.png',
        },
      ],
    };
    const result = transformer!(data);
    expect(result[0]!.text).toContain('<content></content>');
  });

  it('converts data-continue to text "Continue."', () => {
    const transformer = ext.dataPartTransformers?.continue;
    expect(transformer).toBeDefined();

    const result = transformer!({} as never);
    expect(result).toEqual([{ type: 'text', text: 'Continue.' }]);
  });
});

import type { Tool } from '@modelcontextprotocol/client';
import { getEncoding } from 'js-tiktoken';
import { expect, it } from 'vitest';

import { compactToolInfo } from './tool-info';

it('removes schema documentation links and display noise without stripping fields, refs or constraints', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Repeated presentation title',
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Issue title', minLength: 1 },
      url: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'URL',
        type: 'string',
        format: 'uri',
        examples: ['https://example.com'],
      },
      data: {
        default: { $schema: 'literal data', title: 'literal title' },
        enum: [{ title: 'literal title' }],
      },
      next: { $ref: '#/$defs/node' },
    },
    $defs: {
      node: {
        title: 'Node',
        type: 'object',
        properties: { $schema: { type: 'string' } },
      },
    },
    required: ['title', 'url'],
    additionalProperties: false,
  };
  const tool: Tool = {
    name: 'create',
    title: 'Display title',
    description: 'Creates an issue.',
    inputSchema: schema,
    _meta: {
      docs: 'https://example.com/docs',
      verbose: 'unneeded '.repeat(100),
    },
  };
  const original = structuredClone(tool);
  const info = compactToolInfo(tool);
  expect(info).toEqual({
    name: 'create',
    description: 'Creates an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title', minLength: 1 },
        url: { type: 'string', format: 'uri' },
        data: schema.properties.data,
        next: schema.properties.next,
      },
      $defs: {
        node: { type: 'object', properties: { $schema: { type: 'string' } } },
      },
      required: ['title', 'url'],
      additionalProperties: false,
    },
  });
  expect(tool).toEqual(original);
  expect(JSON.stringify(info)).not.toContain('https://json-schema.org');
  const encoding = getEncoding('o200k_base');
  expect(encoding.encode(JSON.stringify(info)).length).toBeLessThan(
    encoding.encode(JSON.stringify(tool)).length * 0.7,
  );
});

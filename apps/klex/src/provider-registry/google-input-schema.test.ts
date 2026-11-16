import type { JSONSchema7 } from '@ai-sdk/provider';
import Ajv from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { googleInputSchema } from './google-input-schema';

describe('googleInputSchema', () => {
  it('preserves the JSON value contract for independent body and parameters definitions', () => {
    const schema = z.toJSONSchema(
      z.strictObject({
        body: z.json().optional(),
        parameters: z.record(z.string(), z.json()).optional(),
      }),
    ) as JSONSchema7;
    const before = structuredClone(schema);
    const mapped = googleInputSchema(schema);
    const ajv = new Ajv({ strict: false });
    const original = ajv.compile(schema);
    const adapted = ajv.compile(mapped);
    for (const body of [
      null,
      false,
      0,
      'text',
      [],
      {},
      [{ a: [{ b: [1, true, null] }] }],
    ]) {
      for (const input of [
        { body },
        { parameters: { value: body } },
        { body, parameters: { value: body } },
      ]) {
        expect(original(input)).toBe(true);
        expect(adapted(input)).toBe(true);
      }
    }
    for (const invalid of [
      { parameters: [] },
      { parameters: null },
      { extra: true },
    ]) {
      expect(original(invalid)).toBe(false);
      expect(adapted(invalid)).toBe(false);
    }
    expect(schema).toEqual(before);
    expect(JSON.stringify(mapped.$defs)).not.toContain('"$ref"');
  });

  it('supports definitions and escaped definition names without rewriting literal data', () => {
    const schema = z.toJSONSchema(z.json()) as JSONSchema7;
    // Root recursion uses "#", independent of a generated definition name.
    expect(JSON.stringify(googleInputSchema(schema))).not.toContain('"$ref"');
    const literalDefault = JSON.parse(JSON.stringify(schema));
    const nested: JSONSchema7 = {
      type: 'object',
      properties: { data: { $ref: '#/definitions/a~1b~0c' } },
      definitions: {
        'a/b~c': JSON.parse(
          JSON.stringify(schema).replaceAll('"#"', '"#/definitions/a~1b~0c"'),
        ),
      },
      default: literalDefault,
    };
    const mapped = googleInputSchema(nested);
    expect(mapped.default).toBe(literalDefault);
    expect(JSON.stringify(mapped.definitions)).not.toContain('"$ref"');
    expect(mapped.properties).toBe(nested.properties);
  });

  it('does not weaken constrained recursion, ordinary schemas, or acyclic references', () => {
    const json = z.toJSONSchema(z.json()) as JSONSchema7;
    const constrained = structuredClone(json);
    const array = constrained.anyOf?.find(
      (branch) => typeof branch === 'object' && branch.type === 'array',
    );
    if (!array || typeof array !== 'object')
      throw new Error('Missing array branch');
    array.minItems = 1;
    const schemas: JSONSchema7[] = [
      constrained,
      // Constraints on the referenced union also apply at every recursive
      // level; erasing the edges here would silently weaken those constraints.
      { ...json, maxProperties: 1 },
      { ...json, not: { type: 'null' } },
      { type: 'object', properties: { data: { ...json, $id: 'nested.json' } } },
      {
        type: 'object',
        properties: { next: { $ref: '#' } },
        required: ['next'],
      },
      { type: 'object', properties: { next: { $ref: '#' } } },
      { type: 'array', items: { $ref: '#' } },
      {
        type: 'object',
        properties: { name: { $ref: '#/$defs/name' } },
        $defs: { name: { type: 'string' } },
      },
      {
        type: 'object',
        properties: { anyOf: { type: 'string' }, $ref: { type: 'string' } },
      },
    ];
    for (const schema of schemas)
      expect(googleInputSchema(schema)).toBe(schema);
  });
});

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@/tool-provider';

import { compileToolValidator } from './tool-validation';

describe('MCP input validation', () => {
  it('does not coerce, default or remove fields and respects extra-property semantics', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'number', default: 1 } },
    };
    const validate = compileToolValidator(schema);
    const input = { extra: true };
    validate(input);
    expect(input).toEqual({ extra: true });
    expect(() => validate({ count: '1' })).toThrow('current tool schema');
    expect(() =>
      compileToolValidator({ ...schema, additionalProperties: false })(input),
    ).toThrow();
  });

  it('supports nested arrays, enums, null, unions, local and recursive refs', () => {
    const validate = compileToolValidator({
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: { anyOf: [{ enum: ['a', 'b'] }, { type: 'null' }] },
        },
        next: { $ref: '#' },
      },
      additionalProperties: false,
    });
    validate({ values: ['a', null], next: { next: {} } });
    expect(() => validate({ values: ['secret-invalid-value'] })).toThrow();
    try {
      validate({ values: ['secret-invalid-value'] });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('secret-invalid-value');
    }
  });

  it.each([
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2020-12/schema',
  ])('supports dialect %s', ($schema) => {
    compileToolValidator({ $schema, type: 'object' })({});
  });

  it.each([
    { $schema: 'unknown' },
    { properties: { a: { format: 'unknown-format' } } },
    { $ref: 'https://example.com/schema' },
    { $dynamicRef: 'https://example.com/schema' },
    { $async: true, required: ['missing'] },
    { unknownValidation: true },
    { type: 'invalid' },
  ])('fails closed on unsupported or malformed schemas: %j', (schema) => {
    expect(() =>
      compileToolValidator(schema as unknown as JsonObject),
    ).toThrow();
  });

  it('validates standard formats, patterns and pattern properties without changing inputs', () => {
    const validate = compileToolValidator({
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        email: { type: 'string', format: 'email' },
        at: { type: 'string', format: 'date-time' },
        id: { type: 'string', pattern: '^[a-z]+$' },
      },
      patternProperties: { '^count_': { type: 'integer' } },
      additionalProperties: false,
    });
    validate({
      url: 'https://example.com',
      email: 'a@example.com',
      at: '2026-11-09T10:00:00Z',
      id: 'abc',
      count_a: 2,
    });
    const invalidInputs: JsonObject[] = [
      { url: 'not a uri' },
      { email: 'bad' },
      { at: 'yesterday' },
      { id: '123' },
      { count_a: '2' },
    ];
    for (const input of invalidInputs) {
      expect(() => validate(input)).toThrow('current tool schema');
    }
  });

  it('interrupts pathological regex validation instead of hanging', () => {
    const validate = compileToolValidator({
      type: 'object',
      properties: { value: { type: 'string', pattern: '^(a+)+$' } },
    });
    expect(() => validate({ value: `${'a'.repeat(100)}!` })).toThrow(
      'execution budget',
    );
  });

  it('supports document-local dynamic references in draft 2020-12', () => {
    const validate = compileToolValidator({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $dynamicAnchor: 'node',
      type: 'object',
      properties: { next: { $dynamicRef: '#node' } },
    });
    validate({ next: {} });
    expect(() => validate({ next: 1 })).toThrow('current tool schema');
  });

  it('does not mistake enum/default data for schema keywords', () => {
    compileToolValidator({
      type: 'object',
      properties: {
        a: { enum: [{ pattern: 'literal' }], default: { format: 'literal' } },
      },
    })({ a: { pattern: 'literal' } });
  });

  it('rejects excessive depth and nonfinite values', () => {
    const validate = compileToolValidator({ type: 'object' });
    expect(() => validate({ n: Number.NaN })).toThrow();
    let deep = {};
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => validate(deep)).toThrow();
    expect(() => validate({ text: 'x'.repeat(128 * 1024 + 1) })).toThrow();
  });
});

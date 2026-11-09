import { runInNewContext } from 'node:vm';

import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { type JsonObject, ToolGatewayError } from '@/tool-provider';

const MAX_BYTES = 128 * 1024;

/** Iterative budget check runs before recursive validators/serialization. */
export function checkToolJson(value: unknown, schema = false): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    const item = entry.value;
    if (++nodes > 4096 || entry.depth > 32) fail();
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail();
    } else if (typeof item === 'object') {
      if (seen.has(item)) fail();
      seen.add(item);
      if (
        !Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        fail();
      for (const [key, child] of Object.entries(item)) {
        bytes += Buffer.byteLength(key);
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    } else fail();
    if (bytes > MAX_BYTES) fail();
  }
  function fail(): never {
    throw new ToolGatewayError(
      schema ? 'invalid-schema' : 'invalid-params',
      'JSON must be finite, acyclic, plain data within 128 KiB, 4096 nodes and depth 32. Inspect getToolInfo.',
    );
  }
}

/** Compilation and validation both have a V8 deadline; no remote refs are loaded. */
export function compileToolValidator(
  schema: JsonObject,
): (input: JsonObject) => void {
  checkToolJson(schema, true);
  const dialect = schema.$schema;
  const Constructor =
    dialect === undefined ||
    dialect === 'http://json-schema.org/draft-07/schema#' ||
    dialect === 'https://json-schema.org/draft-07/schema#'
      ? Ajv
      : dialect === 'https://json-schema.org/draft/2019-09/schema'
        ? Ajv2019
        : dialect === 'https://json-schema.org/draft/2020-12/schema'
          ? Ajv2020
          : undefined;
  if (!Constructor)
    throw new ToolGatewayError(
      'unsupported-schema',
      'Unsupported JSON Schema dialect. Ask the server to publish draft-07, 2019-09 or 2020-12.',
    );
  // Walk schema positions, not arbitrary enum/default/example data.
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node))
      return;
    const object = node as Record<string, unknown>;
    for (const key of ['$async']) {
      if (Object.hasOwn(object, key))
        throw new ToolGatewayError(
          'unsupported-schema',
          'Asynchronous schema validation is unsupported.',
        );
    }
    if (
      ['$ref', '$dynamicRef', '$recursiveRef'].some(
        (key) =>
          typeof object[key] === 'string' && !object[key].startsWith('#'),
      )
    )
      throw new ToolGatewayError(
        'unsupported-schema',
        'Only document-local schema references are supported; remote schemas are never fetched.',
      );
    for (const key of [
      'properties',
      'patternProperties',
      '$defs',
      'definitions',
      'dependentSchemas',
    ]) {
      const map = object[key];
      if (map && typeof map === 'object')
        for (const child of Object.values(map)) visit(child);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      const list = object[key];
      if (Array.isArray(list)) for (const child of list) visit(child);
    }
    for (const key of [
      'additionalProperties',
      'unevaluatedProperties',
      'propertyNames',
      'items',
      'additionalItems',
      'contains',
      'not',
      'if',
      'then',
      'else',
      'unevaluatedItems',
    ]) {
      const child = object[key];
      if (Array.isArray(child)) for (const item of child) visit(item);
      else visit(child);
    }
    const dependencies = object.dependencies;
    if (dependencies && typeof dependencies === 'object')
      for (const child of Object.values(dependencies)) visit(child);
  };
  visit(schema);
  let validate: ValidateFunction;
  try {
    validate = runInNewContext(
      'compile()',
      {
        compile: () =>
          addFormats(
            new Constructor({
              strict: true,
              strictTypes: false,
              strictTuples: false,
              strictRequired: false,
              allErrors: false,
              coerceTypes: false,
              useDefaults: false,
              removeAdditional: false,
              validateFormats: true,
              addUsedSchema: true,
              inlineRefs: false,
            }),
          ).compile(schema),
      },
      { timeout: 1000 },
    ) as ValidateFunction;
  } catch {
    throw new ToolGatewayError(
      'invalid-schema',
      'Schema is invalid, unsupported or exceeds the 1000ms compilation budget. Ask the server to simplify it.',
    );
  }
  return (input) => {
    checkToolJson(input);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ToolGatewayError(
        'invalid-params',
        'params must be a JSON object. Inspect getToolInfo.',
      );
    let valid: boolean;
    try {
      valid = runInNewContext(
        'validate(input)',
        { validate, input },
        { timeout: 100 },
      ) as boolean;
    } catch {
      throw new ToolGatewayError(
        'invalid-params',
        'Input exceeds the validation execution budget. Simplify it; inspect getToolInfo.',
      );
    }
    if (!valid)
      throw new ToolGatewayError(
        'invalid-params',
        'Input does not match the current tool schema. Inspect getToolInfo and correct the indicated fields.',
        (validate.errors ?? []).slice(0, 3).map((error) => ({
          path:
            error.instancePath.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 160) ||
            '/',
          keyword: error.keyword.slice(0, 40),
        })),
      );
  };
}

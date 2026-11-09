import type { Tool } from '@modelcontextprotocol/client';

import type { JsonObject, JsonValue } from '@/tool-provider';

const schemaMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaChildren = new Set([
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
  'contentSchema',
]);

/** Presentation only: never mutate or use this projection for validation. */
export function compactToolInfo(tool: Tool): JsonObject {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: compactSchema(tool.inputSchema as JsonObject),
    ...(tool.outputSchema
      ? { outputSchema: compactSchema(tool.outputSchema as JsonObject) }
      : {}),
    ...(tool.annotations
      ? {
          annotations: Object.fromEntries(
            Object.entries(tool.annotations).filter(([key]) => key !== 'title'),
          ) as JsonObject,
        }
      : {}),
  };
}

function compactSchema(value: JsonValue): JsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      // Dialect declarations and display-only annotations add no argument guidance.
      // Keep identifiers/anchors/refs, constraints, descriptions and default values.
      if (['$schema', '$comment', 'title', 'examples'].includes(key)) return [];
      if (
        schemaMaps.has(key) &&
        child &&
        typeof child === 'object' &&
        !Array.isArray(child)
      ) {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(child).map(([name, schema]) => [
                name,
                compactSchema(schema),
              ]),
            ),
          ],
        ];
      }
      if (schemaLists.has(key) && Array.isArray(child))
        return [[key, child.map(compactSchema)]];
      if (schemaChildren.has(key))
        return [
          [
            key,
            Array.isArray(child)
              ? child.map(compactSchema)
              : compactSchema(child),
          ],
        ];
      if (
        key === 'dependencies' &&
        child &&
        typeof child === 'object' &&
        !Array.isArray(child)
      ) {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(child).map(([name, schema]) => [
                name,
                Array.isArray(schema) ? schema : compactSchema(schema),
              ]),
            ),
          ],
        ];
      }
      return [[key, child]];
    }),
  );
}

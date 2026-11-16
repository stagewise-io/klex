import type { JSONSchema7 } from '@ai-sdk/provider';

type Schema = Record<string, unknown>;

function object(value: unknown): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: unknown, expected: Schema): boolean {
  return (
    object(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, entry]) =>
      object(entry) ? exact(value[key], entry) : value[key] === entry,
    )
  );
}

/**
 * Zod's JSON-value union describes every JSON value, but its object branch's
 * additionalProperties self-reference is rejected by Gemini as a required ref
 * loop. An unconstrained item/property schema has exactly the same meaning:
 * JSON arrays and objects can only contain JSON values. Keep the union and all
 * surrounding constraints, replacing only these redundant recursive edges.
 *
 * Deliberately do not generalize this to constrained recursive schemas: making
 * their recursive edges unconstrained would change the declared contract.
 */
export function googleInputSchema(schema: JSONSchema7): JSONSchema7 {
  const visit = (value: unknown, pointer: string): unknown => {
    if (!object(value)) return value;
    // A nested resource changes the base of fragment references. Leave it to
    // the provider instead of treating its refs as pointers into this root.
    if (pointer !== '#' && typeof value.$id === 'string') return value;
    let result = value;
    const set = (key: string, next: unknown) => {
      if (next === value[key]) return;
      if (result === value) result = { ...value };
      result[key] = next;
    };
    const branches = value.anyOf;
    const ref = { $ref: pointer };
    if (
      Object.keys(value).every((key) =>
        ['anyOf', '$schema', 'title', 'description', '$comment'].includes(key),
      ) &&
      Array.isArray(branches) &&
      branches.length === 6 &&
      ['string', 'number', 'boolean', 'null'].every((type) =>
        branches.some((branch) => exact(branch, { type })),
      ) &&
      branches.some((branch) => exact(branch, { type: 'array', items: ref })) &&
      branches.some(
        (branch) =>
          exact(branch, { type: 'object', additionalProperties: ref }) ||
          exact(branch, {
            type: 'object',
            propertyNames: { type: 'string' },
            additionalProperties: ref,
          }),
      )
    ) {
      set(
        'anyOf',
        branches.map((branch) =>
          branch.type === 'array'
            ? { ...branch, items: {} }
            : branch.type === 'object'
              ? { ...branch, additionalProperties: true }
              : branch,
        ),
      );
    }

    // Walk schema keywords only. Literal defaults/examples and property names
    // such as "$ref" or "anyOf" are data, not schemas.
    for (const key of [
      '$defs',
      'definitions',
      'properties',
      'patternProperties',
      'dependentSchemas',
    ]) {
      const entries = value[key];
      if (!object(entries)) continue;
      let mapped = entries;
      for (const [name, child] of Object.entries(entries)) {
        const escaped = name.replaceAll('~', '~0').replaceAll('/', '~1');
        const next = visit(child, `${pointer}/${key}/${escaped}`);
        if (next !== child) {
          if (mapped === entries) mapped = { ...entries };
          mapped[name] = next;
        }
      }
      set(key, mapped);
    }
    for (const key of [
      'items',
      'additionalItems',
      'additionalProperties',
      'contains',
      'propertyNames',
      'not',
      'if',
      'then',
      'else',
      'allOf',
      'anyOf',
      'oneOf',
      'prefixItems',
      'unevaluatedItems',
      'unevaluatedProperties',
    ]) {
      const child = result[key];
      if (Array.isArray(child)) {
        const next = child.map((entry, i) =>
          visit(entry, `${pointer}/${key}/${i}`),
        );
        if (next.some((entry, i) => entry !== child[i])) set(key, next);
      } else if (object(child)) {
        set(key, visit(child, `${pointer}/${key}`));
      }
    }
    return result;
  };
  return visit(schema, '#') as JSONSchema7;
}

declare const environmentIdBrand: unique symbol;

export type EnvironmentId = string & { readonly [environmentIdBrand]: true };

export function createEnvironmentId(value: string): EnvironmentId {
  return validateId(value, 'Environment ID') as EnvironmentId;
}

function validateId(value: string, name: string): string {
  if (value.length === 0) throw new TypeError(`${name} must not be empty`);
  if (value !== value.trim())
    throw new TypeError(`${name} must not have leading or trailing whitespace`);
  return value;
}

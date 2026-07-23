declare const tenantIdBrand: unique symbol;
declare const agentIdBrand: unique symbol;
declare const environmentIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };
export type AgentId = string & { readonly [agentIdBrand]: true };
export type EnvironmentId = string & { readonly [environmentIdBrand]: true };

export interface AgentPrincipal {
  readonly kind: 'agent';
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
}

export interface EnvironmentPrincipal {
  readonly kind: 'environment';
  readonly tenantId: TenantId;
  readonly environmentId: EnvironmentId;
}

export interface GatewayAuthorization {
  authorize(
    agent: AgentPrincipal,
    environment: EnvironmentPrincipal,
  ): Promise<boolean>;
}

export function createTenantId(value: string): TenantId {
  return validateId(value, 'Tenant ID') as TenantId;
}

export function createAgentId(value: string): AgentId {
  return validateId(value, 'Agent ID') as AgentId;
}

export function createEnvironmentId(value: string): EnvironmentId {
  return validateId(value, 'Environment ID') as EnvironmentId;
}

function validateId(value: string, name: string): string {
  if (value.length === 0) throw new TypeError(`${name} must not be empty`);
  if (value !== value.trim())
    throw new TypeError(`${name} must not have leading or trailing whitespace`);
  return value;
}

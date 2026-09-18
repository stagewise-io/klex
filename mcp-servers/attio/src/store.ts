import type { Envelope } from './credentials.js';

export interface Principal {
  tenantId: string;
  principalId: string;
}
export interface Connection {
  id: string;
  tenantId: string;
  principalId: string;
  clientId: string;
  clientSecret: Envelope;
  generation: number;
  status: 'pending' | 'active' | 'disconnected' | 'reconnect_required';
  workspaceId?: string;
  scopes?: string[];
  token?: Envelope;
}
export interface Attempt {
  stateHash: string;
  tenantId: string;
  principalId: string;
  sessionHash: string;
  connectionId: string;
  generation: number;
  expiresAt: number;
}
/** All mutations must be atomic across processes. Reads must be strongly consistent.
 * CAS replaces the complete row only if its generation matches; next must increment it.
 * consume must delete only an unexpired attempt matching the complete caller binding.
 * Implementations must return detached copies and never log credential fields.
 */
export interface ConnectionStore {
  create(connection: Connection): Promise<boolean>;
  get(tenantId: string, connectionId: string): Promise<Connection | undefined>;
  compareAndSet(next: Connection, expectedGeneration: number): Promise<boolean>;
  putAttempt(attempt: Attempt): Promise<void>;
  consumeAttempt(
    stateHash: string,
    principal: Principal,
    sessionHash: string,
    now: number,
  ): Promise<Attempt | undefined>;
}

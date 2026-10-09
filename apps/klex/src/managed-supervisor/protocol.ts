import { z } from 'zod';

/** Mirrored in Klex managed-supervisor/protocol.ts. Keep wire version explicit. */
export const MANAGED_LEASE_PROTOCOL_VERSION = 1;
export const MANAGED_LEASE_TIMING = Object.freeze({
  pollMs: 5_000,
  requestTimeoutMs: 3_000,
  renewalLeadMs: 60_000,
  drainLeadMs: 40_000,
  safetyMarginMs: 5_000,
  terminalDrainMs: 345_000,
  startupTimeoutMs: 330_000,
});

export function validateManagedLeaseTiming(leaseMs: number) {
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <=
      MANAGED_LEASE_TIMING.renewalLeadMs +
        MANAGED_LEASE_TIMING.pollMs +
        MANAGED_LEASE_TIMING.requestTimeoutMs +
        MANAGED_LEASE_TIMING.safetyMarginMs
  ) {
    throw new Error(
      'Managed bot lease must exceed the renewal and delivery budget',
    );
  }
}

export const managedExecutionIdentitySchema = z.strictObject({
  agentId: z.uuid(),
  activationId: z.uuid(),
  sessionId: z.uuid(),
  attemptId: z.uuid(),
  podUid: z.uuid(),
});
export type ManagedExecutionIdentity = z.infer<
  typeof managedExecutionIdentitySchema
>;

export const managedLeaseRequestSchema = managedExecutionIdentitySchema.extend({
  protocolVersion: z.literal(MANAGED_LEASE_PROTOCOL_VERSION),
  nonce: z.uuid(),
});
export type ManagedLeaseRequest = z.infer<typeof managedLeaseRequestSchema>;

export const managedLeaseResponseSchema = managedLeaseRequestSchema.extend({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  serverNow: z.iso.datetime(),
  fundedUntil: z.iso.datetime(),
  mode: z.enum(['run', 'drain', 'deny']),
});
export type ManagedLeaseResponse = z.infer<typeof managedLeaseResponseSchema>;

/** Reports carry durations, not trusted client wall-clock cutoffs. */
export const managedExecutionReportSchema =
  managedExecutionIdentitySchema.extend({
    protocolVersion: z.literal(MANAGED_LEASE_PROTOCOL_VERSION),
    eventId: z.uuid(),
    authorizationNonce: z.uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    event: z.enum(['launched', 'ready', 'draining', 'stopped']),
    reason: z.enum([
      'startup',
      'ordinary_stop',
      'lease_expiry',
      'authorization_denied',
      'child_exit',
      'startup_failed',
      'supervisor_shutdown',
    ]),
    elapsedSinceAuthorizationMs: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  });
export type ManagedExecutionReport = z.infer<
  typeof managedExecutionReportSchema
>;

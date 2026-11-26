import type { IncomingMessage } from 'node:http';

import { z } from 'zod';

// Mirrors stagewise-io/cloud: apps/mcp-proxy/src/machine-facts.ts and
// packages/db/src/machine-facts.ts. Cloud drops any report this rejects and
// the computer page then shows no facts and a generic icon.

const MAX_HEADER_BYTES = 4096;

const factString = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim());
const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const machineReportedFactsSchema = z.strictObject({
  v: z.literal(1),
  machineVersion: factString,
  os: z.strictObject({
    platform: factString,
    arch: factString,
    release: factString.optional(),
    name: factString.optional(),
  }),
  cpu: z.strictObject({
    model: factString.optional(),
    logicalCores: positiveSafeInteger.optional(),
  }),
  memory: z.strictObject({ totalBytes: positiveSafeInteger.optional() }),
  host: z
    .strictObject({
      deviceType: z
        .enum(['laptop', 'desktop', 'server', 'vm', 'container'])
        .optional(),
      hostname: factString.optional(),
      workspacePath: z.string().min(1).max(1024).optional(),
      workspaceVolumeTotalBytes: positiveSafeInteger.optional(),
    })
    .optional(),
});

export type MachineReportedFacts = z.infer<typeof machineReportedFactsSchema>;

export type ParsedMachineFacts =
  | { status: 'missing' }
  | {
      status: 'invalid';
      reason: 'duplicate' | 'encoding' | 'size' | 'json' | 'schema';
      detail?: unknown;
    }
  | { status: 'valid'; facts: MachineReportedFacts };

export function parseMachineFacts(
  request: Pick<IncomingMessage, 'rawHeaders'>,
): ParsedMachineFacts {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'x-klex-machine-facts') {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length === 0) return { status: 'missing' };
  if (values.length !== 1) return { status: 'invalid', reason: 'duplicate' };
  const value = values[0] ?? '';
  if (value.length > MAX_HEADER_BYTES)
    return { status: 'invalid', reason: 'size' };
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    return { status: 'invalid', reason: 'encoding' };
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value)
    return { status: 'invalid', reason: 'encoding' };
  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    return { status: 'invalid', reason: 'json' };
  }
  const parsed = machineReportedFactsSchema.safeParse(document);
  return parsed.success
    ? { status: 'valid', facts: parsed.data }
    : {
        status: 'invalid',
        reason: 'schema',
        detail: { document, issues: parsed.error.issues },
      };
}

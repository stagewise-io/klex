import { z } from 'zod';

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const position = z.number().int().nonnegative();
const usage = z
  .object({
    createdAt: timestamp,
    updatedAt: timestamp,
    lastReadAt: timestamp.nullable(),
    readCount: position,
    createdTurn: position,
    updatedTurn: position,
    lastReadTurn: position.nullable(),
    userEdited: z.boolean(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .passthrough();
// Metadata is namespace-owned and preserves unknown keys. The forward step
// changes only the known loadOn discriminator; all other payload is retained.
export const skillRegistryV1Schema = z
  .object({
    turn: position,
    skills: z.record(z.string(), usage),
  })
  .passthrough();
export const skillRegistryV2Schema = z
  .object({
    turn: position,
    skills: z.record(z.string(), usage),
  })
  .passthrough();
export const skillRegistryV1 = { version: 1, schema: skillRegistryV1Schema };
export const skillRegistryV2 = { version: 2, schema: skillRegistryV2Schema };

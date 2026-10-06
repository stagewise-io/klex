import { z } from 'zod';

import { type LearnedSkill, validateSkill } from './skill-store';

const writeOperationFields = {
  name: z.string(),
  description: z.string(),
  body: z.string(),
  reason: z.string().optional().default(''),
  evidenceEpisodes: z.array(z.string().max(200)).max(6).optional(),
};

const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), ...writeOperationFields }),
  z.object({
    op: z.literal('update'),
    ...writeOperationFields,
    /** Skills folded into this one; their provenance carries over. */
    mergedFrom: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal('delete'),
    name: z.string(),
    reason: z.string().optional().default(''),
  }),
]);

const responseSchema = z
  .object({
    operations: z.array(z.unknown()),
    deferred: z.boolean().optional(),
  })
  .refine((value) => !value.deferred || value.operations.length === 0);

export type SkillOperation = z.infer<typeof operationSchema>;
export type WriteOperation = Extract<
  SkillOperation,
  { op: 'create' | 'update' }
>;

export type ParseOperationsResult =
  | {
      ok: true;
      operations: SkillOperation[];
      dropped: number;
      deferred?: boolean;
    }
  | { ok: false; error: string };

const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i;

/**
 * Parses the model reply. The whole reply fails only when it is not a JSON
 * object with an `operations` array; malformed single operations are
 * dropped and counted.
 */
export function parseOperations(
  text: string,
  options: { allowDelete: boolean; evidence?: ReadonlySet<string> },
): ParseOperationsResult {
  const trimmed = text.trim();
  const json = FENCE.exec(trimmed)?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: 'reply is not valid JSON' };
  }
  const response = responseSchema.safeParse(value);
  if (!response.success)
    return { ok: false, error: 'reply has no operations array' };
  const operations: SkillOperation[] = [];
  let dropped = 0;
  for (const candidate of response.data.operations) {
    const operation = operationSchema.safeParse(candidate);
    if (
      !operation.success ||
      (operation.data.op === 'delete' && !options.allowDelete) ||
      (operation.success &&
        operation.data.op !== 'delete' &&
        options.evidence !== undefined &&
        (operation.data.evidenceEpisodes ?? []).some(
          (id) => !options.evidence?.has(id),
        ))
    ) {
      dropped += 1;
      continue;
    }
    operations.push(operation.data);
  }
  return {
    ok: true,
    operations,
    dropped,
    ...(response.data.deferred ? { deferred: true } : {}),
  };
}

export interface RejectedOperation {
  operation: SkillOperation;
  reason: string;
}

export interface ValidatedOperations {
  accepted: SkillOperation[];
  rejected: RejectedOperation[];
}

/**
 * Checks each operation against the skill names as they are after the
 * operations before it, so a create followed by an update is allowed.
 */
export function validateOperations(
  operations: readonly SkillOperation[],
  existingNames: Iterable<string>,
): ValidatedOperations {
  const names = new Set(existingNames);
  const accepted: SkillOperation[] = [];
  const rejected: RejectedOperation[] = [];
  for (const operation of operations) {
    const reason = rejectionReason(operation, names);
    if (reason) {
      rejected.push({ operation, reason });
      continue;
    }
    if (operation.op === 'delete') names.delete(operation.name);
    else names.add(operation.name);
    accepted.push(operation);
  }
  return { accepted, rejected };
}

function rejectionReason(
  operation: SkillOperation,
  names: ReadonlySet<string>,
): string | null {
  const exists = names.has(operation.name);
  if (operation.op === 'create' && exists)
    return `skill "${operation.name}" already exists`;
  if (operation.op !== 'create' && !exists)
    return `unknown skill "${operation.name}"`;
  if (operation.op === 'delete') return null;
  return validateSkill(toSkill(operation));
}

export function toSkill(operation: WriteOperation): LearnedSkill {
  return {
    name: operation.name,
    description: operation.description.trim(),
    body: operation.body.trim(),
  };
}

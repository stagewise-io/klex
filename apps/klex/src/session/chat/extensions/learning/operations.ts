import { z } from 'zod';

import {
  MAX_BODY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SKILLS,
  SKILL_NAME_PATTERN,
} from './learning-config';
import { type LearnedSkill, validateSkill } from './skill-store';

const skillNameSchema = z
  .string()
  .max(MAX_NAME_LENGTH)
  .regex(SKILL_NAME_PATTERN);

const writeOperationFields = {
  name: skillNameSchema,
  description: z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH),
  body: z.string().trim().min(1).max(MAX_BODY_LENGTH),
  reason: z.string().optional().default(''),
  evidenceEpisodes: z.array(z.string().max(200)).max(6).optional(),
};

const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), ...writeOperationFields }),
  z.object({
    op: z.literal('update'),
    ...writeOperationFields,
    /** Skills folded into this one; their provenance carries over. */
    mergedFrom: z.array(skillNameSchema).max(MAX_SKILLS).optional(),
  }),
  z.object({
    op: z.literal('delete'),
    name: skillNameSchema,
    reason: z.string().trim().min(1),
  }),
]);

export const learningSubmissionSchema = z.object({
  operations: z.array(operationSchema).max(MAX_SKILLS * 2),
  deferred: z.boolean().optional(),
});

export type LearningSubmission = z.infer<typeof learningSubmissionSchema>;

export type SkillOperation = z.infer<typeof operationSchema>;
export type WriteOperation = Extract<
  SkillOperation,
  { op: 'create' | 'update' }
>;

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

import { z } from 'zod';

const identifier = z.string().trim().min(1).max(1000);
export const recallAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(4000),
  entities: z.array(identifier).max(20).default([]),
  skills: z.array(identifier).max(20).default([]),
  entitySections: z
    .array(z.object({ entity: identifier, section: identifier }))
    .max(20)
    .default([]),
  skillReferences: z
    .array(z.object({ skill: identifier, reference: identifier }))
    .max(20)
    .default([]),
});
export type RecallAnswer = z.infer<typeof recallAnswerSchema>;

/** Legacy results remain readable; bodies never travel in selections. */
export function parseRecallAnswer(value: unknown): RecallAnswer | null {
  const result = recallAnswerSchema.safeParse(value);
  if (!result.success) return null;
  const { data } = result;
  const unique = <T>(items: T[]): T[] => [
    ...new Map(items.map((item) => [JSON.stringify(item), item])).values(),
  ];
  return {
    ...data,
    entities: [
      ...new Set([
        ...data.entities,
        ...data.entitySections.map((item) => item.entity),
      ]),
    ],
    skills: [
      ...new Set([
        ...data.skills,
        ...data.skillReferences.map((item) => item.skill),
      ]),
    ],
    entitySections: unique(data.entitySections),
    skillReferences: unique(data.skillReferences),
  };
}

/** Presentation only. Callers retain the canonical structured result. */
export function recallAnswerText(
  toolName: string | undefined,
  output: unknown,
): string | null {
  return toolName === 'recallFromMemory'
    ? (parseRecallAnswer(output)?.answer ?? null)
    : null;
}

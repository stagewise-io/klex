import { z } from 'zod';

const isoTimestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'Timestamp must be a valid ISO 8601 datetime',
  });
const legacySkillStateSchema = z
  .object({
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    lastReadAt: isoTimestamp.nullable(),
    readCount: z.number().int().nonnegative(),
    sourceEpisodes: z.array(z.string()),
  })
  .passthrough();
export const learningV1 = z
  .object({
    cursor: z.string().nullable(),
    episodeFailures: z.record(z.string(), z.number().int().nonnegative()),
    changedRunsSinceConsolidation: z.number().int().nonnegative(),
    lastConsolidationAt: isoTimestamp.nullable(),
    skills: z.record(z.string(), legacySkillStateSchema),
  })
  .passthrough();
const activity = z.number().int().nonnegative();
const deferredSchema = z
  .object({ id: z.string(), after: z.string(), attempts: activity })
  .passthrough();
export const learningV2 = learningV1.extend({
  processedEpisodeCount: activity,
  pendingChangeWeight: activity,
  lastConsolidationEpisode: activity,
  lastConsolidationSkillCount: activity,
  consolidationFailures: activity,
  nextConsolidationEpisode: activity.nullable(),
  deferred: z.array(deferredSchema).max(20),
  skills: z.record(
    z.string(),
    legacySkillStateSchema.extend({
      userEdited: z.boolean().default(false),
      createdEpisode: activity,
      updatedEpisode: activity,
      lastReadEpisode: activity.nullable(),
    }),
  ),
});

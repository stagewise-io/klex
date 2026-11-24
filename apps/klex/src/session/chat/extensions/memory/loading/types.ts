import { z } from 'zod';

import type {
  loadMatcherSchema,
  MemoryEntity,
} from '@/session/chat/extensions/memory/writer/entities';

export type LoadMatcher = z.infer<typeof loadMatcherSchema>;
export const ENTITY_PREFIX = 'extensions/io.stagewise/memory/entities/';
export const snapshotSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['entity', 'skill', 'skill-reference', 'detail']),
  references: z.array(z.string()).optional(),
  window: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  entityType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  linkedIdentities: z
    .array(
      z.object({ server: z.string(), match: z.record(z.string(), z.string()) }),
    )
    .optional(),
  section: z.string().optional(),
  sections: z.array(z.string()).default([]),
  body: z.string(),
  removed: z.boolean().optional(),
});
export type MemorySnapshot = z.infer<typeof snapshotSchema>;
export type SnapshotMap = Record<string, string>;
export interface RankedMemory {
  filename: string;
  tier: number;
  recency: number;
}
export interface LoadingStatus {
  version: 1;
  budget: number;
  ranked: RankedMemory[];
  removed: string[];
  unavailable: string[];
}
export interface EntityReader {
  snapshot(): Promise<MemoryEntity[]>;
}
export const detailResultSchema = z.object({
  memorySection: z.literal(1),
  filename: z.string(),
  sectionName: z.string(),
  snapshot: z.string(),
});
export type DetailResult = z.infer<typeof detailResultSchema>;
export const lexical = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
export const detailKey = (filename: string, section: string): string =>
  JSON.stringify([filename, section]);
export function parseSnapshot(value: string): MemorySnapshot | null {
  try {
    return snapshotSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}
export function entitySnapshot(entity: MemoryEntity): string {
  return JSON.stringify({
    version: 1,
    kind: 'entity',
    title: entity.id,
    tags: entity.frontmatter.Tags,
    linkedIdentities: entity.frontmatter.LinkedIdentities,
    sections: Object.keys(entity.sections).filter((name) => name !== 'General'),
    body: (entity.sections.General ?? [])
      .map((fact) => `- ${fact.text}`)
      .join('\n'),
  });
}
export function sectionSnapshot(entity: MemoryEntity, section: string): string {
  return JSON.stringify({
    version: 1,
    kind: 'detail',
    title: entity.id,
    section,
    sections: [],
    body: (entity.sections[section] ?? [])
      .map((fact) => `- ${fact.text}`)
      .join('\n'),
    ...(!Object.hasOwn(entity.sections, section) ? { removed: true } : {}),
  });
}

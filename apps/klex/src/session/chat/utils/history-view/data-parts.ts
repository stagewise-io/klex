import type { FilePart, TextPart } from 'ai';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import {
  type BlockField,
  type DataBlock,
  field,
  renderBlockSegments,
  serializeContextValue,
} from './blocks';
import { truncateText } from './truncate';
import type { FieldLimit } from './types';

export type BlockProjection = (
  data: unknown,
  occurrence: number,
) => readonly DataBlock[];

/** Extensions return blocks only. Rendering belongs to the model boundary. */
export type DataPartTransformer = ((
  data: unknown,
  occurrence?: number,
) => readonly DataBlock[]) & {
  history?: BlockProjection;
};
export type DataPartRegistry = Readonly<Record<string, DataPartTransformer>>;

/** One dispatcher per pass. Count all source parts, even outside the selected view. */
export function createDataPartDispatcher(transformers: DataPartRegistry) {
  const counts = new Map<string, number>();
  return {
    consume(part: ExtendedUIMessage['parts'][number]): number {
      if (!part.type.startsWith('data-')) return 0;
      const key = part.type.slice(5);
      const occurrence = counts.get(key) ?? 0;
      counts.set(key, occurrence + 1);
      return occurrence;
    },
    project(
      key: string,
      data: unknown,
      occurrence: number,
      history = false,
    ): readonly DataBlock[] {
      const transformer = transformers[key];
      if (!Object.hasOwn(transformers, key) || !transformer) return [];
      return (history ? (transformer.history ?? transformer) : transformer)(
        data,
        occurrence,
      );
    },
    materialize(
      key: string,
      data: unknown,
      occurrence: number,
    ): (TextPart | FilePart)[] {
      const transformer = transformers[key];
      if (!Object.hasOwn(transformers, key) || !transformer) return [];
      return transformer(data, occurrence).flatMap((block) =>
        renderBlockSegments(block).map((segment): TextPart | FilePart =>
          segment.type === 'text'
            ? segment
            : {
                type: 'file',
                mediaType: segment.mediaType,
                data: segment.data,
              },
        ),
      );
    },
  };
}

/** Bound values before rendering, preserving provenance and nested field structure. */
export function compactDataBlocks(
  blocks: readonly DataBlock[],
  options: { limit?: FieldLimit; media?: 'inline' | 'placeholder' },
): readonly DataBlock[] {
  const compactField = (entry: BlockField): BlockField => {
    if (entry.kind === 'fields')
      return { ...entry, fields: entry.fields.map(compactField) };
    if (entry.kind === 'sequence')
      return { ...entry, items: entry.items.map(compactField) };
    if (entry.kind === 'media')
      return options.media === 'inline'
        ? entry
        : field(
            entry.key,
            `${entry.media.kind} ${entry.media.mediaType}`,
            'external',
          );
    const limit = options.limit;
    if (!limit) return entry;
    if (entry.kind === 'table') {
      return {
        ...entry,
        rows: entry.rows.map((row) =>
          row.map((value) =>
            truncateText(
              typeof value === 'string' ? value : serializeContextValue(value),
              limit,
            ),
          ),
        ),
      };
    }
    const value =
      typeof entry.value === 'string'
        ? entry.value
        : serializeContextValue(entry.value);
    return value.length <= limit.max
      ? entry
      : { ...entry, value: truncateText(value, limit) };
  };
  return blocks.map((block) =>
    block.value !== undefined
      ? {
          ...block,
          value: options.limit
            ? truncateText(block.value, options.limit)
            : block.value,
        }
      : {
          ...block,
          ...(block.body ? { body: compactField(block.body) } : {}),
          fields: block.fields.map(compactField),
        },
  );
}

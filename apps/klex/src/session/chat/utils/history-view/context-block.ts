import type { ContextDataUIPart } from '@/session/inbox';

import {
  type BlockField,
  type DataBlock,
  field,
  serializeContextValue,
} from './blocks';

/** Shared presentation of live context; delivery bookkeeping stays internal. */
export function contextBlock(data: ContextDataUIPart): DataBlock {
  const { origin, data: payload, ...envelope } = data.metadata;
  const mcp = origin === 'events' || origin === 'push-notifications';
  const fields: BlockField[] = [
    field(
      'source',
      data.sourceEnv,
      origin === 'push-notifications' ? 'trusted' : 'external',
    ),
  ];
  if (mcp) {
    const visible = Object.fromEntries(
      Object.entries(envelope).filter(
        ([key]) =>
          key !== 'eventId' && !(origin === 'events' && key === '_meta'),
      ),
    );
    if (Object.keys(visible).length) fields.push(field('identity', visible));
    if (Object.hasOwn(data.metadata, 'data'))
      fields.push(field(origin === 'events' ? 'data' : 'metadata', payload));
  } else if (Object.keys(data.metadata).length)
    fields.push(field('metadata', data.metadata));
  const content: BlockField[] = [];
  for (const item of data.content) {
    const key = 'part';
    if (item.type === 'image' || item.type === 'audio') {
      content.push({
        key,
        kind: 'media',
        media: {
          type: 'media',
          kind: item.type,
          mediaType: item.mimeType.toLowerCase(),
          data: item.data,
        },
      });
    } else if (
      item.type === 'resource' &&
      'blob' in item.resource &&
      item.resource.blob !== undefined
    ) {
      const { blob, ...resource } = item.resource;
      content.push(field(key, { resource }));
      const mediaType =
        resource.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ||
        'application/octet-stream';
      content.push({
        key: `${key}Media`,
        kind: 'media',
        media: {
          type: 'media',
          kind: mediaType.startsWith('audio/') ? 'audio' : 'image',
          mediaType,
          data: blob.replaceAll(/\s/g, ''),
        },
      });
    } else if (item.type === 'text') content.push(field(key, item.text));
    else content.push(field(key, serializeContextValue(item)));
  }
  if (content.length)
    fields.push({ key: 'content', kind: 'sequence', items: content });
  return {
    type:
      origin === 'events'
        ? 'event'
        : origin === 'push-notifications'
          ? 'push-notification'
          : 'input',
    fields,
  };
}

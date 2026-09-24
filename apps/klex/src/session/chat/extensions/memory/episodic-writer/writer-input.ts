import type { FilePart } from 'ai';

import type {
  DataPartTransformers,
  Extension,
  ExtensionFactory,
} from '@/session/chat/extensions/extension-api';
import {
  createDataPart,
  dataPartTransformer,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

const EVENT_KEY = 'memory-writer-event';
const IMAGE_KEY = 'memory-writer-image';
const AUDIO_KEY = 'memory-writer-audio';

type WriterEventData = { text: string };
type WriterMediaData = { data: string; mediaType: string };

class WriterInputExt implements Extension {
  dataPartTransformers: DataPartTransformers = {
    [EVENT_KEY]: dataPartTransformer<WriterEventData>((data) => [
      { type: 'text', text: data.text },
    ]),
    [IMAGE_KEY]: dataPartTransformer<WriterMediaData>((data) => [
      createFilePart(data),
    ]),
    [AUDIO_KEY]: dataPartTransformer<WriterMediaData>((data) => [
      createFilePart(data),
    ]),
  };
}

export const createWriterInputExt: ExtensionFactory = {
  identifier: 'io.stagewise/memory-writer-input',
  displayName: 'Memory Writer Input',
  create: () => new WriterInputExt(),
};

export function createWriterEventPart(
  text: string,
): ExtendedUIMessage['parts'][number] {
  return createDataPart(EVENT_KEY, { text }) as never;
}

export function createWriterMediaPart(
  type: 'image' | 'audio',
  mediaType: string,
  data: string,
): ExtendedUIMessage['parts'][number] {
  const key = type === 'image' ? IMAGE_KEY : AUDIO_KEY;
  return createDataPart(key, {
    data,
    mediaType: mediaType.toLowerCase(),
  }) as never;
}

function createFilePart(data: WriterMediaData): FilePart {
  return {
    type: 'file',
    data: { type: 'data', data: data.data },
    mediaType: data.mediaType,
  };
}

import { blockLines, field, quote, RECORD_SEPARATOR } from './blocks';

export {
  LINES_FORMAT_PROMPT,
  quote,
  RECORD_SEPARATOR,
  renderDataRecord,
  serializeContextValue,
} from './blocks';

import { fitPrefix, fitPrefixWithOmission } from './fit';
import type {
  ContextItem,
  FittedMessage,
  FittedRecord,
  HistoryRole,
  HistorySegment,
  LineRendererOptions,
  ProjectedMessage,
  RenderedMessage,
} from './types';

export const LINES_TRUNCATION_MARKER =
  '# omission\nreason: "earlier history omitted"';

const MAX_WORD_LENGTH = 64;
const UNSAFE_WORD_CHARACTERS = /[^A-Za-z0-9_.+/-]/g;

type Media = Extract<HistorySegment, { type: 'media' }>;
/** A text line, or inline media following the line before it. */
type Line = string | Media;

/**
 * Renders records as blank-line separated blocks. Structural lines (record
 * headers, section labels, omission markers) come only from the renderer;
 * every external content line starts with `¦ ` and bot content with `~ `.
 * These boundaries distinguish literal data from renderer structure. Inline context media becomes
 * `media` segments right after its `image`/`audio` line. The agent's own
 * records carry a `your_` prefix, so a reader can tell them apart from
 * anything the outside world sent.
 */
export function renderLineMessage(
  message: ProjectedMessage,
  options: LineRendererOptions = {},
): RenderedMessage | null {
  const fitted = fitLineMessage(message, options);
  return fitted ? renderFittedMessage(fitted) : null;
}

/**
 * Applies the per-message line limits without rendering: drops trailing
 * records past `messageLimit` and trailing context items past
 * `contextLimit`, measured on the rendered line text. Null when nothing fits.
 */
export function fitLineMessage(
  message: ProjectedMessage,
  options: LineRendererOptions = {},
): FittedMessage | null {
  const candidates = message.records
    .map((record) => {
      const fitted =
        record.kind === 'context'
          ? fitContext(record, options.contextLimit)
          : record;
      return { record: fitted, lines: renderRecord(fitted, message.role) };
    })
    .filter(
      ({ record, lines }) =>
        record.kind !== 'context' ||
        options.contextLimit === undefined ||
        blockText(lines).length <= options.contextLimit,
    );
  if (candidates.length === 0) return null;
  const kept =
    options.messageLimit === undefined
      ? candidates
      : fitPrefixWithOmission(
          candidates,
          (prefix) => measureBlocks(prefix.map(({ lines }) => lines)),
          options.messageLimit,
          (candidate, omitted) => ({
            ...candidate,
            lines: [
              ...candidate.lines,
              omittedPartsLine(
                omitted + message.records.length - candidates.length,
              ),
            ],
          }),
        );
  if (kept.length === 0) return null;
  return {
    id: message.id,
    role: message.role,
    records: kept.map(({ record }) => record),
    omittedRecords: message.records.length - kept.length,
  };
}

export function renderFittedMessage(message: FittedMessage): RenderedMessage {
  const last = message.records.length - 1;
  const blocks = message.records.map((record, index) =>
    renderBlock(
      record,
      message.role,
      index === last ? message.omittedRecords : 0,
    ),
  );
  return {
    text: blocks.map(blockText).join(RECORD_SEPARATOR),
    segments: blocks.flatMap(blockSegments),
  };
}

/**
 * Line text of one record block, without media segments. A positive
 * `omittedRecords` appends the omission marker of the message's last record.
 */
export function renderRecordText(
  record: FittedRecord,
  role: HistoryRole,
  omittedRecords = 0,
): string {
  return blockText(renderBlock(record, role, omittedRecords));
}

function renderBlock(
  record: FittedRecord,
  role: HistoryRole,
  omittedRecords: number,
): Line[] {
  const lines = renderRecord(record, role);
  return omittedRecords > 0
    ? [...lines, omittedPartsLine(omittedRecords)]
    : lines;
}

function omittedPartsLine(omitted: number): string {
  return `omittedParts: ${omitted}`;
}

function measureBlocks(blocks: readonly Line[][]): number {
  return blocks.map(blockText).join(RECORD_SEPARATOR).length;
}

function blockText(block: readonly Line[]): string {
  return block
    .filter((line): line is string => typeof line === 'string')
    .join('\n');
}

function blockSegments(block: readonly Line[]): HistorySegment[] {
  const segments: HistorySegment[] = [];
  let text = '';
  for (const line of block) {
    if (typeof line === 'string') {
      text += text && !text.endsWith('\n') ? `\n${line}` : line;
      continue;
    }
    segments.push({ type: 'text', text: `${text}\n` });
    segments.push(line);
    text = '';
  }
  segments.push({ type: 'text', text: `${text}${RECORD_SEPARATOR}` });
  return segments;
}

function renderRecord(record: FittedRecord, role: HistoryRole): Line[] {
  switch (record.kind) {
    case 'text':
      return blockLines({
        type: role === 'assistant' ? 'your_output' : role,
        fields: [
          field('content', record.text, role === 'user' ? 'external' : 'bot'),
        ],
      });
    case 'reasoning':
      return blockLines({
        type: 'your_thinking',
        fields: [field('content', record.text, 'bot')],
      });
    case 'summary':
      return blockLines({
        type: 'summary',
        fields: [field('content', record.text, 'bot')],
      });
    case 'data':
      return record.blocks.flatMap((block, index) => [
        ...(index ? [''] : []),
        ...blockLines(block),
      ]);
    case 'tool': {
      const botResult = [
        'readEntity',
        'readSkill',
        'loadSkill',
        'readMemorySection',
        'recall',
        'recallFromMemory',
      ].includes(record.name);
      return blockLines({
        type: 'your_action',
        fields: [
          field('tool', record.name, 'trusted'),
          field('status', record.status, 'trusted'),
          ...(record.input !== undefined
            ? [field('input', record.input, 'bot')]
            : []),
          ...(record.output !== undefined
            ? [field('result', record.output, botResult ? 'bot' : 'external')]
            : []),
          ...(record.error !== undefined ? [field('error', record.error)] : []),
        ],
      });
    }
    case 'context':
      return renderContext(record);
  }
}

type FittedContext = Extract<FittedRecord, { kind: 'context' }>;

function fitContext(
  record: FittedContext,
  limit: number | undefined,
): FittedContext {
  if (limit === undefined) return record;
  const withItems = (items: ContextItem[]): FittedContext => {
    const omittedItems = record.items.length - items.length;
    return omittedItems > 0
      ? { ...record, items, omittedItems }
      : { ...record, items };
  };
  let items = fitPrefix(
    record.items,
    (prefix) => blockText(renderContext(withItems([...prefix]))).length,
    limit,
  );
  while (
    items.length &&
    blockText(renderContext(withItems(items))).length > limit
  )
    items = items.slice(0, -1);
  return withItems(items);
}

function renderContext(record: FittedContext): Line[] {
  const lines: Line[] = blockLines({
    type: record.type ?? 'input',
    fields: [
      field(
        'source',
        record.source,
        record.type === 'push-notification' ? 'trusted' : 'external',
      ),
      ...(record.metadata !== undefined
        ? [field('metadata', record.metadata)]
        : []),
    ],
  });
  if (record.items.length) lines.push('content: |');
  for (const item of record.items) lines.push(...renderItem(item));
  const omitted = record.omittedItems ?? 0;
  if (omitted > 0) lines.push(`omittedItems: ${omitted}`);
  return lines;
}

function renderItem(item: ContextItem): Line[] {
  switch (item.kind) {
    case 'text':
      return quote(item.text);
    case 'image':
    case 'audio': {
      const header = `¦ ${item.kind} ${mediaWord(item.kind, item.mimeType)}`;
      if (item.data === undefined) return [header];
      return [
        header,
        {
          type: 'media',
          kind: item.kind,
          mediaType: item.mimeType,
          data: item.data,
        },
      ];
    }
    case 'resource_link': {
      const lines: Line[] = [];
      if (item.uri === undefined) lines.push(...quote('resource_link'));
      if (item.uri !== undefined) lines.push(...quote(`uri: ${item.uri}`));
      if (item.name) lines.push(...quote(`name: ${item.name}`));
      return lines;
    }
    case 'resource': {
      const lines: Line[] = [];
      if (item.uri === undefined) lines.push(...quote('resource'));
      if (item.uri !== undefined) lines.push(...quote(`uri: ${item.uri}`));
      if (item.text !== undefined) lines.push(...quote(item.text));
      return lines;
    }
  }
}

/** Header word: one space-free token that cannot break the line structure. */
function word(value: string): string {
  return (
    value.replace(UNSAFE_WORD_CHARACTERS, '_').slice(0, MAX_WORD_LENGTH) || '_'
  );
}

function mediaWord(kind: 'image' | 'audio', mimeType: string): string {
  const prefix = `${kind}/`;
  return word(
    mimeType.startsWith(prefix) ? mimeType.slice(prefix.length) : mimeType,
  );
}

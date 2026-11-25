import { isToolUIPart } from 'ai';
import { getEncoding } from 'js-tiktoken';
import { z } from 'zod';

import { isDataPartOf } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

import {
  detailKey,
  detailResultSchema,
  ENTITY_PREFIX,
  type LoadingStatus,
  lexical,
  type MemorySnapshot,
  parseSnapshot,
} from './types';

const quote = (value: string) =>
  value
    .split(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/u)
    .map((line) => `¦${line}`)
    .join('\n');
const inline = (value: string) =>
  value.replace(/[\r\n\v\f\u0085\u2028\u2029]/gu, ' ');
const labelString = (value: string) =>
  JSON.stringify(value)
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
const displayFilename = (filename: string) =>
  filename.startsWith(ENTITY_PREFIX)
    ? filename.slice(ENTITY_PREFIX.length)
    : filename;
const identities = (snapshot: MemorySnapshot) =>
  (snapshot.linkedIdentities ?? [])
    .map(
      (identity) =>
        `${identity.server}: ${Object.entries(identity.match)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}`,
    )
    .join('\n');
const encoder = getEncoding('cl100k_base');
const loadingStatusSchema = z.object({
  version: z.literal(1),
  budget: z.number().int().positive().max(8000),
  ranked: z.array(
    z.object({
      filename: z.string(),
      tier: z.number().int().min(0).max(2),
      recency: z.number().int().min(-1),
    }),
  ),
  removed: z.array(z.string()),
  unavailable: z.array(z.string()),
});
interface Entry {
  index: number;
  filename: string;
  snapshot: MemorySnapshot;
  key: string;
}
function body(snapshot: MemorySnapshot): string {
  return [
    ...(snapshot.sections.length
      ? [
          'additionalSections',
          ...snapshot.sections.map((section) => `- ${inline(section)}`),
        ]
      : []),
    'facts',
    snapshot.body,
  ].join('\n');
}
/** Bounded contiguous line replacement. Common prefix/suffix are omitted. */
export function diff(before: string, after: string): string {
  const a = before.split('\n'),
    b = after.split('\n');
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    `@@ -${start + 1},${a.length - start - end} +${start + 1},${b.length - start - end} @@`,
    ...a.slice(start, a.length - end).map((line) => `-${line}`),
    ...b.slice(start, b.length - end).map((line) => `+${line}`),
  ].join('\n');
}
function metadataDiff(
  previous: MemorySnapshot,
  snapshot: MemorySnapshot,
): string {
  const changes: string[] = [];
  if (previous.description !== snapshot.description)
    changes.push(`Description changed: ${snapshot.description ?? '(removed)'}`);
  if (previous.entityType !== snapshot.entityType)
    changes.push(`Entity type changed: ${snapshot.entityType ?? '(removed)'}`);
  if (JSON.stringify(previous.tags) !== JSON.stringify(snapshot.tags))
    changes.push(`Tags changed: ${snapshot.tags?.join(',') || '(removed)'}`);
  if (
    JSON.stringify(previous.linkedIdentities) !==
    JSON.stringify(snapshot.linkedIdentities)
  )
    changes.push(
      `Linked identities changed:\n${identities(snapshot) || '(removed)'}`,
    );
  return changes.length ? `\n${changes.join('\n')}` : '';
}
function block(
  entry: Entry,
  previous?: MemorySnapshot,
  replacement = false,
): string {
  const snapshot = entry.snapshot;
  const label = `${labelString(displayFilename(entry.filename))}${snapshot.section ? ` section=${labelString(snapshot.section)}` : ''}`;
  if (snapshot.removed) return `memory-update ${label} removed`;
  const current = body(snapshot);
  if (previous && !previous.removed) {
    // Bound diff work independently of admission; oversized changes use a
    // complete replacement and still pass through the shared token budget.
    const before = body(previous);
    if (
      before.length + current.length > 100_000 ||
      previous.body.split('\n').length + snapshot.body.split('\n').length >
        10_000
    ) {
      previous = undefined;
      replacement = true;
    } else {
      const patch = diff(before, current);
      const metadata = metadataDiff(previous, snapshot);
      if (body(previous) === current && metadata)
        return `memory-update ${label}\nmetadata\n${quote(metadata.trim())}`;
      if (patch.length + metadata.length < current.length)
        return `memory-update ${label}\npatch\n${quote(patch)}${metadata ? `\nmetadata\n${quote(metadata.trim())}` : ''}`;
      replacement = true;
    }
  }
  const tag = snapshot.kind === 'detail' ? 'memory-detail' : 'memory';
  const linked = (snapshot.linkedIdentities ?? [])
    .map(
      (identity) =>
        `${inline(identity.server)}:\n${Object.entries(identity.match)
          .map(([key, value]) => `  ${inline(key)}: ${inline(value)}`)
          .join('\n')}`,
    )
    .join('\n');
  return [
    `${tag} ${label}${replacement ? ' replacement' : ''}`,
    ...(snapshot.entityType
      ? [`entityType\n${quote(snapshot.entityType)}`]
      : []),
    ...(snapshot.tags?.length
      ? [`tags\n${quote(snapshot.tags.join(','))}`]
      : []),
    ...(snapshot.description
      ? [`description\n${quote(snapshot.description)}`]
      : []),
    ...(linked ? [`linkedIdentities\n${quote(linked)}`] : []),
    ...(snapshot.sections.length
      ? [
          `additionalSections\n${quote(snapshot.sections.map((section) => `- ${inline(section)}`).join('\n'))}`,
        ]
      : []),
    `facts\n${quote(snapshot.body)}`,
  ].join('\n');
}
export interface MemoryRenderingMetrics {
  emittedFull: number;
  emittedDiff: number;
  emittedDetail: number;
  omittedDocuments: number;
  omittedTokens: number;
  invalidSnapshots: number;
  emittedTokens: number;
}
export function materializeMemories(
  messages: ExtendedUIMessage[],
  onMetrics?: (metrics: MemoryRenderingMetrics) => void,
): ExtendedUIMessage[] {
  const metrics: MemoryRenderingMetrics = {
    emittedFull: 0,
    emittedDiff: 0,
    emittedDetail: 0,
    omittedDocuments: 0,
    omittedTokens: 0,
    invalidSnapshots: 0,
    emittedTokens: 0,
  };
  const entries: Entry[] = [];
  let status: LoadingStatus | undefined;
  const active = new Set<string>();
  const stripped = messages.map((message, index) => ({
    ...message,
    parts: message.parts.flatMap<ExtendedUIMessage['parts'][number]>((part) => {
      if (
        isToolUIPart(part) &&
        part.state === 'output-available' &&
        (part.type === 'dynamic-tool'
          ? part.toolName === 'readMemorySection'
          : part.type === 'tool-readMemorySection')
      ) {
        const parsed = detailResultSchema.safeParse(part.output);
        if (parsed.success) {
          const { filename, sectionName, snapshot: raw } = parsed.data;
          const key = detailKey(filename, sectionName);
          active.add(key);
          const snapshot = parseSnapshot(raw);
          if (snapshot)
            entries.push({ index, filename, snapshot, key: `detail:${key}` });
          else metrics.invalidSnapshots++;
          return [
            {
              ...part,
              output: {
                status: 'section snapshot available in memory context',
              },
            } as unknown as ExtendedUIMessage['parts'][number],
          ];
        }
      }
      if (isDataPartOf('memoryLoadingStatus', part)) {
        const parsed = loadingStatusSchema.safeParse(
          (part as unknown as { data: unknown }).data,
        );
        if (parsed.success) status = parsed.data;
        return [];
      }
      if (
        !isDataPartOf('loadedMemories', part) &&
        !isDataPartOf('loadedMemorySections', part)
      )
        return [part];
      const data = (part as unknown as { data: unknown }).data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
      for (const [key, value] of Object.entries(data).sort(([a], [b]) =>
        lexical(a, b),
      )) {
        if (typeof value !== 'string') continue;
        const snapshot = parseSnapshot(value);
        if (!snapshot) {
          metrics.invalidSnapshots++;
          continue;
        }
        let filename = key;
        if (isDataPartOf('loadedMemorySections', part)) {
          if (!active.has(key)) continue;
          try {
            filename = JSON.parse(key)[0];
          } catch {
            continue;
          }
        }
        entries.push({
          index,
          filename,
          snapshot,
          key: snapshot.kind === 'detail' ? `detail:${key}` : `base:${key}`,
        });
      }
      return [];
    }),
  }));
  const chains = new Map<string, Entry[]>();
  for (const entry of entries) {
    const chain = chains.get(entry.key) ?? [];
    if (
      JSON.stringify(chain.at(-1)?.snapshot) !== JSON.stringify(entry.snapshot)
    )
      chain.push(entry);
    chains.set(entry.key, chain);
  }
  const ranks = new Map(
    status?.ranked.map((rank) => [rank.filename, rank]) ?? [],
  );
  const ordered = [...chains.entries()].sort(([a, aa], [b, bb]) => {
    const x = ranks.get(aa.at(-1)!.filename),
      y = ranks.get(bb.at(-1)!.filename);
    return (
      Number(b.startsWith('detail:')) - Number(a.startsWith('detail:')) ||
      (y?.tier ?? 0) - (x?.tier ?? 0) ||
      (y?.recency ?? bb.at(-1)!.index) - (x?.recency ?? aa.at(-1)!.index) ||
      lexical(a, b)
    );
  });
  const budget = Math.max(0, status?.budget ?? 8000);
  const reserve = Math.min(150, budget);
  let remaining = budget - reserve;
  const output = new Map<number, { text: string; sortKey: string }[]>();
  const omitted: string[] = [];
  const omittedDetails = new Set<string>();
  // Charge separators as well as blocks. Encoding concatenated text is not
  // necessarily additive, so retain a small per-block framing allowance.
  const tokenCost = (text: string) => encoder.encode(text, [], []).length + 4;
  const add = (index: number, text: string, sortKey = '\uffff') => {
    const list = output.get(index) ?? [];
    list.push({ text, sortKey });
    output.set(index, list);
  };
  for (const [, chain] of ordered) {
    let rendered = chain.map((entry, index) => ({
      index: entry.index,
      text: block(entry, chain[index - 1]?.snapshot),
    }));
    let cost = rendered.reduce(
      (total, item) => total + tokenCost(item.text),
      0,
    );
    if (cost > remaining && chain.length > 1) {
      const last = chain.at(-1)!;
      rendered = [{ index: last.index, text: block(last, undefined, true) }];
      cost = tokenCost(rendered[0]!.text);
    }
    if (cost > remaining) {
      metrics.omittedDocuments++;
      metrics.omittedTokens += cost;
      omitted.push(chain.at(-1)!.filename);
      if (chain[0]!.snapshot.kind === 'detail')
        omittedDetails.add(chain[0]!.key);
      continue;
    }
    remaining -= cost;
    for (const item of rendered) {
      if (item.text.startsWith('memory-detail ')) metrics.emittedDetail++;
      else if (item.text.startsWith('memory-update ')) metrics.emittedDiff++;
      else metrics.emittedFull++;
      add(item.index, item.text, chain[0]!.filename);
    }
  }
  // Notices share the same hard token budget as facts; a large deletion set
  // must not bypass admission or crowd out an explicitly requested section.
  const omissionCount = `Memory context budget omitted ${omitted.length} documents/sections.`;
  const detailedOmission = `${omissionCount} ${omitted.slice(0, 5).map(displayFilename).map(inline).join(', ')}${omitted.length > 5 ? ', …' : ''}. Explicit section content may be omitted; do not assume it was loaded.`;
  const notices = [
    ...(omitted.length
      ? [
          tokenCost(detailedOmission) <= reserve
            ? detailedOmission
            : omissionCount,
        ]
      : []),
    ...(status?.removed ?? []).map(
      (filename) =>
        `memory-update ${JSON.stringify(displayFilename(filename))} removed`,
    ),
    ...(status?.unavailable.length
      ? [
          `Memory sources unavailable: ${status.unavailable.join(', ')}. This does not mean their documents were deleted.`,
        ]
      : []),
  ];
  if (notices.length && messages.length) {
    const admitted: string[] = [];
    let noticeBudget = remaining + reserve;
    for (const notice of notices) {
      const cost = tokenCost(notice);
      if (cost <= noticeBudget) {
        admitted.push(notice);
        noticeBudget -= cost;
      }
    }
    if (admitted.length < notices.length) {
      const summary = 'Additional memory notices omitted by context budget.';
      if (tokenCost(summary) <= noticeBudget) admitted.push(summary);
    }
    if (admitted.length) add(messages.length - 1, admitted.join('\n'));
  }
  // Do not acknowledge a detail as loaded if budget admission rejected it.
  for (let index = 0; index < stripped.length; index++) {
    const message = stripped[index]!;
    message.parts = message.parts.map((part) => {
      if (!isToolUIPart(part)) return part;
      const source = messages[index]?.parts.find(
        (item) => isToolUIPart(item) && item.toolCallId === part.toolCallId,
      );
      if (
        !source ||
        !isToolUIPart(source) ||
        source.state !== 'output-available'
      )
        return part;
      const result = detailResultSchema.safeParse(source.output);
      if (
        !result.success ||
        !omittedDetails.has(
          `detail:${detailKey(result.data.filename, result.data.sectionName)}`,
        )
      )
        return part;
      return {
        ...part,
        output: {
          error:
            'Section content omitted by memory context budget; it was not loaded.',
        },
      } as ExtendedUIMessage['parts'][number];
    });
  }
  metrics.emittedTokens = [...output.values()].reduce(
    (total, blocks) =>
      total +
      encoder.encode(
        blocks
          .sort((a, b) => lexical(a.sortKey, b.sortKey))
          .map((block) => block.text)
          .join('\n\n'),
        [],
        [],
      ).length,
    0,
  );
  onMetrics?.(metrics);
  return stripped.flatMap((message, index) => [
    ...(message.parts.length ? [message] : []),
    ...(output.has(index)
      ? [
          {
            id: `${message.id}/memory-context`,
            role: 'user' as const,
            parts: [
              {
                type: 'text' as const,
                text: output
                  .get(index)!
                  .sort((a, b) => lexical(a.sortKey, b.sortKey))
                  .map((item) => item.text)
                  .join('\n\n'),
              },
            ],
          },
        ]
      : []),
  ]);
}

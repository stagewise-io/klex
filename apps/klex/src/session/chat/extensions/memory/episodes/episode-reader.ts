import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { parseEpisodeRecordLine, renderEpisodeText } from './episode-format';

export interface EpisodePage {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  text: string;
  offset: number;
  nextOffset: number | null;
  scannedBytes: number;
  /** File content was omitted by the scan or tail character budget. */
  truncated: boolean;
}

/** Retains bytes already consumed when a candidate fails partway through a scan. */
export class EpisodePageReadError extends Error {
  constructor(
    cause: unknown,
    readonly scannedBytes: number,
  ) {
    super('Episode page read failed', { cause });
  }
}

/** Opens only regular episode files inside the root, without following symlinks. */
export async function openEpisodeFile(root: string, id: string) {
  const path = join(root, id);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const canonicalRoot = await realpath(root);
    const canonicalPath = await realpath(path);
    const contained = relative(canonicalRoot, canonicalPath);
    if (contained.startsWith(`..${sep}`) || contained === '..') return null;
    // Reject symbolic links even when they point inside the episode directory.
    for (const component of [root, join(root, id.split('/')[0] ?? ''), path]) {
      if ((await lstat(component)).isSymbolicLink()) return null;
    }
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code ?? '')) return null;
    throw error;
  }
  try {
    if ((await handle.stat()).isFile()) return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return null;
}

/** Reads valid JSONL records with bounded I/O and retained rendered text. */
export async function readEpisodePage(
  root: string,
  id: string,
  options: { offset: number; limit: number; maxBytes: number; tail?: boolean },
): Promise<EpisodePage | null> {
  const handle = await openEpisodeFile(root, id);
  if (!handle) return null;
  let scannedBytes = 0;
  try {
    const stat = await handle.stat();
    const maxBytes = Math.max(
      0,
      Math.min(2_000_000, Math.floor(options.maxBytes)),
    );
    const limit = Math.max(1, Math.min(60_000, Math.floor(options.limit)));
    const offset = Math.max(0, Math.floor(options.offset));
    // Tail investigations inspect EOF, not the end of a bounded prefix.
    const startByte = options.tail ? Math.max(0, stat.size - maxBytes) : 0;
    // Decode complete records independently so a malformed record cannot
    // alter evidence or prevent later valid records from being read.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = Buffer.alloc(Math.min(16_384, Math.max(1, maxBytes)));
    let pending: Buffer[] = [];
    let text = '';
    let renderedLength = 0;
    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let records = 0;
    let enough = false;
    const consume = (parts: Buffer[]) => {
      let line: string;
      try {
        line = decoder.decode(Buffer.concat(parts));
      } catch {
        return;
      }
      const entry = parseEpisodeRecordLine(line);
      if (!entry) return;
      startedAt ??= entry.at;
      endedAt = entry.at;
      const block = `${records++ > 0 ? '\n\n' : ''}${renderEpisodeText(line)}`;
      if (options.tail) text = `${text}${block}`.slice(-limit);
      else {
        const start = Math.max(0, offset - renderedLength);
        text += block.slice(
          start,
          start + Math.max(0, limit + 1 - text.length),
        );
      }
      renderedLength += block.length;
      enough = !options.tail && text.length > limit;
    };
    while (scannedBytes < maxBytes && !enough) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, maxBytes - scannedBytes),
        startByte + scannedBytes,
      );
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      let start = 0;
      while (!enough && start < bytesRead) {
        const newline = buffer.indexOf(10, start);
        if (newline < 0 || newline >= bytesRead) break;
        // Validation rejects a cut JSON fragment but preserves a complete
        // first record when the tail window starts exactly at its boundary.
        pending.push(buffer.subarray(start, newline));
        consume(pending);
        pending = [];
        start = newline + 1;
      }
      if (!enough && start < bytesRead) {
        // The reusable read buffer must not overwrite a partial record.
        pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
      }
    }
    const reachedEnd = startByte + scannedBytes >= stat.size;
    if (reachedEnd && !enough) consume(pending);
    const truncated =
      startByte > 0 ||
      !reachedEnd ||
      (options.tail === true && renderedLength > text.length);
    const hasMore = enough || truncated;
    return {
      id,
      startedAt,
      endedAt,
      text: text.slice(0, limit),
      offset: options.tail ? Math.max(0, renderedLength - text.length) : offset,
      nextOffset:
        hasMore && text.length > 0 && !options.tail
          ? offset + Math.min(text.length, limit)
          : null,
      scannedBytes,
      truncated,
    };
  } catch (error) {
    throw new EpisodePageReadError(error, scannedBytes);
  } finally {
    await handle.close();
  }
}

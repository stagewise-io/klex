import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { parseEpisodeRecordLine, renderEpisodeText } from './episode-format';

export interface EpisodePage {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  text: string;
  offset: number;
  nextOffset: number | null;
  scannedBytes: number;
  /** Some file content could not be inspected within the scan budget. */
  truncated: boolean;
}

/** Reads valid JSONL records with bounded I/O and retained rendered text. */
export async function readEpisodePage(
  root: string,
  id: string,
  options: { offset: number; limit: number; maxBytes: number; tail?: boolean },
): Promise<EpisodePage | null> {
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
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code ?? '')) return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const maxBytes = Math.max(
      0,
      Math.min(2_000_000, Math.floor(options.maxBytes)),
    );
    const limit = Math.max(1, Math.min(60_000, Math.floor(options.limit)));
    const offset = Math.max(0, Math.floor(options.offset));
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(Math.min(16_384, Math.max(1, maxBytes)));
    let pending = '';
    let text = '';
    let renderedLength = 0;
    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let scannedBytes = 0;
    let records = 0;
    let enough = false;
    const consume = (line: string) => {
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
        scannedBytes,
      );
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      while (!enough) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    const truncated = scannedBytes < stat.size;
    if (!truncated && !enough) consume(`${pending}${decoder.end()}`);
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
  } finally {
    await handle.close();
  }
}

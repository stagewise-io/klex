import { getEncoding } from 'js-tiktoken';

// Load once with the core generation module, not on a recorded user request.
export const o200kTokenizer = getEncoding('o200k_base');
const TOKEN_RUN = /\s+|\S+/gu;
const MAX_UNBROKEN_CODE_POINTS = 32;
const MAX_ENCODE_BUFFER_CODE_POINTS = 1_024;

/**
 * Counts conservative o200k_base units in bounded chunks. The tokenizer is
 * quadratic on very long unbroken runs, so split those at 32 code points and
 * aggregate ordinary text into 1K-code-point batches.
 */
export function countO200kBaseUnits(text: string): number {
  if (!text) return 0;
  let total = 0;
  let buffer = '';
  let bufferCodePoints = 0;
  const flush = () => {
    if (!buffer) return;
    total += o200kTokenizer.encode(buffer).length;
    buffer = '';
    bufferCodePoints = 0;
  };
  const append = (piece: string, codePoints: number) => {
    if (bufferCodePoints + codePoints > MAX_ENCODE_BUFFER_CODE_POINTS) flush();
    buffer += piece;
    bufferCodePoints += codePoints;
  };

  for (const [run] of text.matchAll(TOKEN_RUN)) {
    const runCodePoints = countCodePoints(run);
    if (run.trim().length > 0 && runCodePoints > MAX_UNBROKEN_CODE_POINTS) {
      flush();
      let piece = '';
      let pieceCodePoints = 0;
      for (const point of run) {
        piece += point;
        pieceCodePoints += 1;
        if (pieceCodePoints === MAX_UNBROKEN_CODE_POINTS) {
          total += o200kTokenizer.encode(piece).length;
          piece = '';
          pieceCodePoints = 0;
        }
      }
      if (piece) total += o200kTokenizer.encode(piece).length;
      continue;
    }

    let piece = '';
    let pieceCodePoints = 0;
    for (const point of run) {
      piece += point;
      pieceCodePoints += 1;
      if (pieceCodePoints === MAX_UNBROKEN_CODE_POINTS) {
        append(piece, pieceCodePoints);
        piece = '';
        pieceCodePoints = 0;
      }
    }
    if (piece) append(piece, pieceCodePoints);
  }
  flush();
  return total;
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _point of value) count += 1;
  return count;
}

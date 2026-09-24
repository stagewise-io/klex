/**
 * Returns the longest prefix of `candidates` whose measured size stays
 * within `limit`. `measure` receives the whole prefix so renderers can
 * account for separators and wrappers.
 */
export function fitPrefix<T>(
  candidates: readonly T[],
  measure: (prefix: readonly T[]) => number,
  limit: number,
): T[] {
  const included: T[] = [];
  for (const candidate of candidates) {
    if (measure([...included, candidate]) > limit) break;
    included.push(candidate);
  }
  return included;
}

/**
 * Like `fitPrefix`, but annotates the last kept entry with the number of
 * omitted candidates, dropping further entries until the annotated prefix
 * fits as well.
 */
export function fitPrefixWithOmission<T>(
  candidates: readonly T[],
  measure: (prefix: readonly T[]) => number,
  limit: number,
  annotate: (last: T, omitted: number) => T,
): T[] {
  const included = fitPrefix(candidates, measure, limit);
  while (included.length > 0 && included.length < candidates.length) {
    const omitted = candidates.length - included.length;
    const annotated = included.map((entry, index) =>
      index === included.length - 1 ? annotate(entry, omitted) : entry,
    );
    if (measure(annotated) <= limit) return annotated;
    included.pop();
  }
  return included;
}

/**
 * Resolves `true` if `promise` settles before `deadline` (an epoch-ms timestamp).
 * Resolves `false` if the deadline has already passed or the timeout fires first.
 * Rejects only if `promise` itself rejects.
 */
export async function settleBefore(
  promise: Promise<unknown>,
  deadline: number,
): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  return new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(resolve, remaining, false);
    void promise.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

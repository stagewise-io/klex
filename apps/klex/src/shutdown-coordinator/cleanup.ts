/** Bound an individual cleanup step so later resources can still be released. */
export async function closeWithTimeout(
  close: () => Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Resource cleanup timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: readonly unknown[] = [],
): PollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const inFlight = useRef(false);

  const doFetch = useRef(async () => {});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const poll = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await fetcherRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        inFlight.current = false;
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void poll();
    const interval = setInterval(poll, intervalMs);

    doFetch.current = poll;

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  const refresh = useCallback(() => {
    setLoading(true);
    void doFetch.current();
  }, []);

  return {
    data,
    error,
    loading,
    refresh,
  };
}

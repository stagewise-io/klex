import { useCallback, useEffect, useRef, useState } from 'react';

import type { AdminApiClient, CloudStatus, SessionInfo } from '../api-client';

export interface GlobalStatus {
  sessions: SessionInfo[];
  cloud: CloudStatus | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

const POLL_INTERVAL = 5000;

/**
 * Shared polling hook for data shown in the global header/footer.
 * Both sessions and cloud status are fetched on a single interval
 * to avoid redundant timers.
 */
export function useGlobalStatus(apiClient: AdminApiClient): GlobalStatus {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const apiRef = useRef(apiClient);
  apiRef.current = apiClient;

  const poll = useCallback(async () => {
    const results = await Promise.allSettled([
      apiRef.current.getSessions(),
      apiRef.current.getCloudStatus(),
    ]);

    const [sessionResult, cloudResult] = results;

    if (sessionResult.status === 'fulfilled') {
      setSessions(sessionResult.value);
    }
    // On rejection, keep previous session data — don't overwrite with []

    if (cloudResult.status === 'fulfilled') {
      setCloud(cloudResult.value);
    } else {
      setCloud(null);
    }

    const sessionError =
      sessionResult.status === 'rejected' ? sessionResult.reason : null;
    const cloudError =
      cloudResult.status === 'rejected' ? cloudResult.reason : null;
    const firstError = sessionError ?? cloudError;
    setError(firstError instanceof Error ? firstError : null);

    setLoading(false);
  }, []);

  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    void pollRef.current();
    const interval = setInterval(() => void pollRef.current(), POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    void pollRef.current();
  }, []);

  return { sessions, cloud, loading, error, refresh };
}

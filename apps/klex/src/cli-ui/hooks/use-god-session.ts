import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  type SerializedMessage,
  type SessionInfo,
} from '../api-client';

const POLL_INTERVAL_MS = 5_000;
const PAGE_SIZE = 50;

export interface UseGodSessionResult {
  session: SessionInfo | null;
  messages: SerializedMessage[];
  olderMessages: SerializedMessage[];
  allMessages: SerializedMessage[];
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  resetState: () => void;
  refresh: () => void;
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}

export function useGodSession(apiClient: AdminApiClient): UseGodSessionResult {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [messages, setMessages] = useState<SerializedMessage[]>([]);
  const [olderMessages, setOlderMessages] = useState<SerializedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const clientRef = useRef(apiClient);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const pollStateRef = useRef({ running: false, queued: false });
  const loadMoreGenerationRef = useRef<number | null>(null);
  clientRef.current = apiClient;

  const poll = useCallback(async () => {
    const pollState = pollStateRef.current;
    pollState.queued = true;
    if (pollState.running) return;

    pollState.running = true;
    if (mountedRef.current) setLoading(true);

    try {
      while (pollState.queued && mountedRef.current) {
        pollState.queued = false;
        const generation = generationRef.current;
        const [sessionResult, messagesResult] = await Promise.allSettled([
          clientRef.current.getGodSession(),
          clientRef.current.getGodMessages(PAGE_SIZE),
        ]);

        if (!mountedRef.current || generation !== generationRef.current) {
          continue;
        }

        let nextError: Error | null = null;
        if (sessionResult.status === 'fulfilled') {
          const nextSessionId = sessionResult.value.id;
          if (
            sessionIdRef.current !== null &&
            sessionIdRef.current !== nextSessionId
          ) {
            generationRef.current += 1;
            setOlderMessages([]);
            setLoadingMore(false);
          }
          sessionIdRef.current = nextSessionId;
          setSession(sessionResult.value);
        } else if (
          sessionResult.reason instanceof AdminApiClientError &&
          sessionResult.reason.statusCode === 404
        ) {
          sessionIdRef.current = null;
          setSession(null);
          setOlderMessages([]);
        } else {
          nextError = asError(
            sessionResult.reason,
            'Failed to load god session',
          );
        }

        if (messagesResult.status === 'fulfilled') {
          setMessages(messagesResult.value.messages);
          setNextCursor(messagesResult.value.nextCursor);
          setHasMore(messagesResult.value.hasMore);
        } else {
          nextError ??= asError(
            messagesResult.reason,
            'Failed to load god messages',
          );
        }

        setError(nextError);
      }
    } finally {
      pollState.running = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      pollStateRef.current.queued = false;
      clearInterval(interval);
    };
  }, [poll]);

  const loadMore = useCallback(() => {
    if (
      !nextCursor ||
      !hasMore ||
      loadMoreGenerationRef.current === generationRef.current
    )
      return;

    const generation = generationRef.current;
    loadMoreGenerationRef.current = generation;
    setLoadingMore(true);
    void clientRef.current
      .getGodMessages(PAGE_SIZE, nextCursor)
      .then((response) => {
        if (!mountedRef.current || generation !== generationRef.current) return;

        setOlderMessages((previous) => {
          const knownIds = new Set([
            ...messages.map((message) => message.id),
            ...previous.map((message) => message.id),
          ]);
          const unique = response.messages.filter(
            (message) => !knownIds.has(message.id),
          );
          return [...unique, ...previous];
        });
        setNextCursor(response.nextCursor);
        setHasMore(response.hasMore);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (mountedRef.current && generation === generationRef.current) {
          setError(asError(reason, 'Failed to load older messages'));
        }
      })
      .finally(() => {
        if (loadMoreGenerationRef.current === generation) {
          loadMoreGenerationRef.current = null;
          if (mountedRef.current && generation === generationRef.current) {
            setLoadingMore(false);
          }
        }
      });
  }, [hasMore, messages, nextCursor]);

  const resetState = useCallback(() => {
    generationRef.current += 1;
    sessionIdRef.current = null;
    setSession(null);
    setMessages([]);
    setOlderMessages([]);
    setNextCursor(null);
    setHasMore(false);
    setLoadingMore(false);
    setError(null);
  }, []);

  const allMessages = useMemo(() => {
    const latestIds = new Set(messages.map((message) => message.id));
    return [
      ...olderMessages.filter((message) => !latestIds.has(message.id)),
      ...messages,
    ];
  }, [messages, olderMessages]);

  return {
    session,
    messages,
    olderMessages,
    allMessages,
    loading,
    error,
    hasMore,
    loadingMore,
    loadMore,
    resetState,
    refresh: () => void poll(),
  };
}

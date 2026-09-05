import { Box, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type AdminApiClient, AdminApiClientError } from '../api-client';
import { ScreenSection } from '../components/screen-section';
import { useGodSession } from '../hooks/use-god-session';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';
import { formatAge } from '../utils/format-age';
import {
  getVisibleChatEntries,
  maxScrollOffset,
  toGodChatEntries,
} from '../utils/god-message-display';
import { insertComposerText } from '../utils/message-composer';

export interface GodMessagesScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

type Mode = 'overview' | 'compose' | 'sending' | 'confirm-reset';

const STATE_COLORS: Record<string, string> = {
  idle: 'green',
  working: 'yellow',
  retrying: 'red',
  success: 'green',
  terminated: 'red',
};

const STATE_LABELS: Record<string, string> = {
  idle: 'IDLE',
  working: 'WORKING',
  retrying: 'RETRYING',
  success: 'SUCCESS',
  terminated: 'TERMINATED',
};

export function GodMessagesScreen({
  apiClient,
  onBack,
}: GodMessagesScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<Mode>('overview');
  const [message, setMessage] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const modeRef = useRef(mode);
  const messageRef = useRef(message);
  const cursorOffsetRef = useRef(cursorOffset);
  modeRef.current = mode;
  messageRef.current = message;
  cursorOffsetRef.current = cursorOffset;

  const {
    session,
    allMessages,
    hasMore,
    loadingMore,
    loading,
    error,
    loadMore,
    resetState,
    refresh,
  } = useGodSession(apiClient);

  const { stdout } = useStdout();
  const terminalHeight = stdout.rows || 24;

  const chatHeight = Math.max(terminalHeight - 16, 5);
  const showComposer =
    mode === 'compose' || mode === 'sending' || message.length > 0;
  const composerHeight = showComposer ? 4 : 0;
  const historyHeight = Math.max(chatHeight - composerHeight, 2);
  // Each entry renders a role header, content line, and separating blank line.
  const chatViewportSize = Math.max(Math.floor(historyHeight / 3), 1);
  const chatEntries = useMemo(
    () => toGodChatEntries(allMessages),
    [allMessages],
  );
  const maximumScrollOffset = maxScrollOffset(
    chatEntries.length,
    chatViewportSize,
  );
  const chatView = getVisibleChatEntries(
    chatEntries,
    chatViewportSize,
    scrollOffset,
  );

  useEffect(() => {
    setActive(mode === 'compose');
  }, [mode, setActive]);

  const canReset =
    session?.runtimeState === 'idle' || session?.runtimeState === 'terminated';

  useEffect(() => {
    if (mode === 'compose' || mode === 'sending') {
      setMeta({
        title: 'God Messages',
        breadcrumb: ['Home', 'Settings'],
        keys:
          mode === 'sending'
            ? []
            : [
                { key: 'enter', label: 'Send' },
                { key: 'shift+enter', label: 'New line' },
                { key: 'esc', label: 'Keep draft' },
              ],
      });
      return;
    }

    if (mode === 'confirm-reset') {
      setMeta({
        title: 'Confirm Reset',
        breadcrumb: ['Home', 'Settings', 'God Messages'],
        keys: [
          { key: 'y', label: 'Confirm' },
          { key: 'n/esc', label: 'Cancel' },
        ],
      });
      return;
    }

    setMeta({
      title: 'God Messages',
      breadcrumb: ['Home', 'Settings'],
      keys: [
        { key: 'enter', label: message ? 'Edit draft' : 'Compose' },
        ...(canReset
          ? [{ key: 'r', label: 'Reset' }]
          : [{ key: 'r', label: 'Reset (disabled)' }]),
        { key: '↑↓', label: 'Scroll' },
        { key: 'esc', label: 'Back' },
      ],
    });
  }, [setMeta, mode, canReset, message]);

  const beginComposing = useCallback(() => {
    cursorOffsetRef.current = messageRef.current.length;
    modeRef.current = 'compose';
    setCursorOffset(messageRef.current.length);
    setMode('compose');
    setScrollOffset(0);
  }, []);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'sending') return;
      if (mode === 'overview') onBack();
      else if (mode === 'input') setMode('overview');
    },
    [MenuKeys.Enter]: () => {
      if (mode === 'overview') beginComposing();
    },
  });

  const submitMessage = useCallback(
    async (draft: string) => {
      const content = draft.trim();
      if (!content) return;

      modeRef.current = 'sending';
      setMode('sending');
      try {
        const result = await apiClient.sendGodMessage(content);
        pushToast(
          `God message sent to session ${result.sessionId.slice(0, 8)}`,
          'info',
        );
        messageRef.current = '';
        cursorOffsetRef.current = 0;
        modeRef.current = 'overview';
        setMessage('');
        setCursorOffset(0);
        setMode('overview');
        setScrollOffset(0);
        refresh();
      } catch (err) {
        pushToast(
          err instanceof AdminApiClientError
            ? err.message
            : 'Failed to send god message',
          'error',
        );
        modeRef.current = 'compose';
        setMode('compose');
      }
    },
    [apiClient, pushToast, refresh],
  );

  useInput((input, key) => {
    if (modeRef.current !== 'compose') return;

    if (key.escape) {
      modeRef.current = 'overview';
      setMode('overview');
      return;
    }

    if (key.return) {
      if (key.shift) {
        const next = insertComposerText(
          {
            value: messageRef.current,
            cursorOffset: cursorOffsetRef.current,
          },
          '\n',
        );
        messageRef.current = next.value;
        cursorOffsetRef.current = next.cursorOffset;
        setMessage(next.value);
        setCursorOffset(next.cursorOffset);
      } else {
        void submitMessage(messageRef.current);
      }
      return;
    }

    if (key.leftArrow) {
      cursorOffsetRef.current = Math.max(0, cursorOffsetRef.current - 1);
      setCursorOffset(cursorOffsetRef.current);
      return;
    }
    if (key.rightArrow) {
      cursorOffsetRef.current = Math.min(
        messageRef.current.length,
        cursorOffsetRef.current + 1,
      );
      setCursorOffset(cursorOffsetRef.current);
      return;
    }
    if (key.home) {
      cursorOffsetRef.current = 0;
      setCursorOffset(0);
      return;
    }
    if (key.end) {
      cursorOffsetRef.current = messageRef.current.length;
      setCursorOffset(cursorOffsetRef.current);
      return;
    }
    if (key.backspace) {
      const offset = cursorOffsetRef.current;
      if (offset === 0) return;
      const next =
        messageRef.current.slice(0, offset - 1) +
        messageRef.current.slice(offset);
      messageRef.current = next;
      cursorOffsetRef.current = offset - 1;
      setMessage(next);
      setCursorOffset(offset - 1);
      return;
    }
    if (key.delete) {
      const offset = cursorOffsetRef.current;
      const next =
        messageRef.current.slice(0, offset) +
        messageRef.current.slice(offset + 1);
      messageRef.current = next;
      setMessage(next);
      return;
    }
    if (!input || key.ctrl || key.meta || key.tab) return;

    const next = insertComposerText(
      {
        value: messageRef.current,
        cursorOffset: cursorOffsetRef.current,
      },
      input,
    );
    messageRef.current = next.value;
    cursorOffsetRef.current = next.cursorOffset;
    setMessage(next.value);
    setCursorOffset(next.cursorOffset);
  });

  // Reset confirmation key handlers.
  useInput((input, key) => {
    if (mode === 'confirm-reset') {
      if (input.toLowerCase() === 'y') {
        setMode('overview');
        void apiClient
          .resetGodSession()
          .then((result) => {
            resetState();
            refresh();
            pushToast(
              `God session reset — new session ${result.sessionId.slice(0, 8)}`,
              'info',
            );
          })
          .catch((err: unknown) => {
            pushToast(
              err instanceof AdminApiClientError
                ? err.message
                : 'Failed to reset god session',
              'error',
            );
          });
      } else if (input.toLowerCase() === 'n' || key.escape) {
        setMode('overview');
      }
      return;
    }

    if (mode !== 'overview') return;

    if (input.toLowerCase() === 'r' && canReset) {
      setMode('confirm-reset');
    }

    if (key.upArrow) {
      setScrollOffset((previous) => {
        const next = Math.min(previous + 1, maximumScrollOffset);
        if (next === maximumScrollOffset && hasMore && !loadingMore) {
          loadMore();
        }
        return next;
      });
    } else if (key.downArrow) {
      setScrollOffset((previous) =>
        Math.max(0, Math.min(previous, maximumScrollOffset) - 1),
      );
    }
  });

  // --- Confirm reset mode ---

  if (mode === 'confirm-reset') {
    return (
      <ScreenSection title="Confirm Reset" tone="red">
        <Text bold color="red">
          Reset god session?
        </Text>
        <Text dimColor>
          This will terminate the current session and create a fresh one with an
          empty history. All messages will be lost.
        </Text>
        <Box marginTop={1}>
          <Text>
            Press{' '}
            <Text bold color="red">
              [y]
            </Text>{' '}
            to confirm or <Text bold>[n]</Text> / Esc to cancel.
          </Text>
        </Box>
      </ScreenSection>
    );
  }

  const totalEntries = chatEntries.length;

  return (
    <ScreenSection title="God Messages" tone="yellow">
      <Box flexDirection="column" gap={1}>
        {/* Session state panel */}
        {session ? (
          <Box flexDirection="column" gap={0}>
            <Box gap={2}>
              <Text bold color={STATE_COLORS[session.runtimeState] ?? 'white'}>
                {STATE_LABELS[session.runtimeState] ??
                  session.runtimeState.toUpperCase()}
              </Text>
              <Text dimColor>
                ID: {session.id.slice(0, 8)} · Turns: {session.turns} · Steps:{' '}
                {session.steps} · Msgs: {session.messageCount}
              </Text>
            </Box>
            <Text dimColor>
              Model: {session.model.id ?? 'none'}
              {session.model.isFallback
                ? ` (fallback #${session.model.fallbackIndex})`
                : ''}{' '}
              · Age: {formatAge(session.createdAt)}
            </Text>
          </Box>
        ) : (
          <Text dimColor italic>
            No active god session
          </Text>
        )}

        {error ? <Text color="red">{error.message}</Text> : null}

        {/* Chat history */}
        <Box flexDirection="column" marginTop={1} height={chatHeight}>
          <Box flexDirection="column" height={historyHeight}>
            {loading && totalEntries === 0 ? (
              <Text dimColor>
                <Spinner type="dots" /> Loading messages...
              </Text>
            ) : chatView.visible.length === 0 ? (
              <Text dimColor>
                No messages yet. Press Enter to compose a god message.
              </Text>
            ) : (
              <Box flexDirection="column" gap={1}>
                {chatView.visible.map((entry) => (
                  <Box key={entry.id} flexDirection="column">
                    <Text
                      bold
                      color={entry.role === 'user' ? 'yellow' : 'cyan'}
                      wrap="truncate-end"
                    >
                      {entry.role === 'user' ? 'God' : 'Agent'}
                    </Text>
                    <Text wrap="truncate-end">{entry.text}</Text>
                  </Box>
                ))}
              </Box>
            )}
            {loadingMore ? (
              <Text dimColor>
                <Spinner type="dots" /> Loading older messages...
              </Text>
            ) : null}
          </Box>
          {showComposer ? (
            <Box
              borderStyle="round"
              borderColor={mode === 'compose' ? 'yellow' : 'gray'}
              flexDirection="column"
              paddingX={1}
            >
              <Text bold color={mode === 'compose' ? 'yellow' : undefined}>
                {mode === 'compose'
                  ? 'Editing message'
                  : mode === 'sending'
                    ? 'Sending message'
                    : 'Draft'}
              </Text>
              {mode === 'sending' ? (
                <Text>
                  <Spinner type="dots" /> Sending...
                </Text>
              ) : message.length === 0 ? (
                <Text dimColor>Type your god message...</Text>
              ) : mode === 'compose' ? (
                <Text>
                  {message.slice(0, cursorOffset)}
                  <Text inverse>{message[cursorOffset] ?? ' '}</Text>
                  {message.slice(
                    cursorOffset + (cursorOffset < message.length ? 1 : 0),
                  )}
                </Text>
              ) : (
                <Text>{message}</Text>
              )}
            </Box>
          ) : null}
        </Box>

        {/* Scroll indicator */}
        {totalEntries > chatViewportSize ? (
          <Text dimColor>
            {chatView.scrollOffset > 0
              ? `↑ ${chatView.scrollOffset} older · ↓ scroll down`
              : 'Following latest'}
            {hasMore ? ' · more available' : ''}
          </Text>
        ) : null}

        {/* Disclaimer + key hints */}
        <Box flexDirection="column" gap={0}>
          <Text dimColor>
            God messages are authoritative directives processed by a dedicated
            session.
          </Text>
          <Text dimColor>
            Press{' '}
            <Text bold color="yellow">
              Enter
            </Text>{' '}
            to {message ? 'edit draft' : 'compose'} ·{' '}
            <Text bold color={canReset ? 'red' : 'gray'}>
              [r]
            </Text>{' '}
            to reset
            {!canReset ? ' (busy)' : ''} · <Text bold>↑↓</Text> scroll
          </Text>
        </Box>
      </Box>
    </ScreenSection>
  );
}

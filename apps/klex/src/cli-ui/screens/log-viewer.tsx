import { Box, Text, useInput, useStdout } from 'ink';
import { useEffect, useMemo, useState } from 'react';

import type { CapturedLogEntry } from '@stagewise/logger';

import type { LogStore } from '@/log-store';

import { ScreenSection } from '../components/screen-section';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { MenuKeys, useMenuInput } from '../menu-keys';

type MinimumLevel = 'DEBUG' | 'INFO' | 'WARNING';
type LogStyle = 'minimal' | 'verbose';

const LEVELS: MinimumLevel[] = ['DEBUG', 'INFO', 'WARNING'];
const LEVEL_RANK: Record<string, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
};

export function LogViewerScreen({
  logStore,
  onBack,
}: {
  logStore: LogStore;
  onBack: () => void;
}) {
  const { setMeta } = useScreenMeta();
  const { stdout } = useStdout();
  const [version, setVersion] = useState(0);
  const [minimumLevel, setMinimumLevel] = useState<MinimumLevel>('INFO');
  const [style, setStyle] = useState<LogStyle>('minimal');
  // null means follow the newest entry. A sequence pins the viewport while
  // logs continue arriving, so scrolling up does not drift back to the tail.
  const [endSequence, setEndSequence] = useState<number | null>(null);

  useEffect(
    () => logStore.subscribe(() => setVersion((value) => value + 1)),
    [logStore],
  );
  useEffect(() => {
    setMeta({
      title: 'Logs',
      breadcrumb: ['Home', 'Settings'],
      keys: [
        { key: '↑↓', label: 'Scroll' },
        { key: 'l', label: 'Level' },
        { key: 'v', label: 'Style' },
        { key: 'esc', label: 'Back' },
      ],
    });
  }, [setMeta]);

  useMenuInput({
    [MenuKeys.Back]: onBack,
    l: () => {
      setMinimumLevel(
        (current) =>
          LEVELS[(LEVELS.indexOf(current) + 1) % LEVELS.length] ?? 'INFO',
      );
      setEndSequence(null);
    },
    v: () =>
      setStyle((current) => (current === 'minimal' ? 'verbose' : 'minimal')),
  });

  const entries = useMemo(() => {
    void version;
    const threshold =
      minimumLevel === 'WARNING' ? 3 : minimumLevel === 'DEBUG' ? 1 : 2;
    return logStore
      .getEntries()
      .filter((entry) => (LEVEL_RANK[entry.level] ?? 2) >= threshold);
  }, [logStore, minimumLevel, version]);
  const visibleRows = Math.max((stdout.rows || 24) - 12, 4);
  const end = resolveViewportEnd(entries, endSequence, visibleRows);
  const visible = entries.slice(Math.max(0, end - visibleRows), end);
  const offset = entries.length - end;

  useInput((_input, key) => {
    if (!key.upArrow && !key.pageUp && !key.downArrow && !key.pageDown) return;

    const delta = key.pageUp || key.pageDown ? visibleRows : 1;
    setEndSequence((current) => {
      const currentEnd = resolveViewportEnd(entries, current, visibleRows);
      const nextEnd =
        key.upArrow || key.pageUp
          ? Math.max(Math.min(visibleRows, entries.length), currentEnd - delta)
          : Math.min(entries.length, currentEnd + delta);
      return nextEnd >= entries.length
        ? null
        : (entries[nextEnd - 1]?.sequence ?? null);
    });
  });

  return (
    <ScreenSection title="Runtime logs">
      <Box gap={2}>
        <Text>
          Minimum:{' '}
          <Text bold color="blue">
            {minimumLevel}
          </Text>
        </Text>
        <Text>
          Style:{' '}
          <Text bold color="blue">
            {style}
          </Text>
        </Text>
        <Text dimColor>{entries.length} entries</Text>
      </Box>
      <Text dimColor>
        {offset > 0
          ? `Paused · ${offset} entries newer`
          : 'Following latest logs'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {visible.length === 0 ? (
          <Text dimColor>No logs at this level.</Text>
        ) : (
          visible.map((entry) => (
            <LogLine key={entry.sequence} entry={entry} style={style} />
          ))
        )}
      </Box>
    </ScreenSection>
  );
}

function LogLine({
  entry,
  style,
}: {
  entry: CapturedLogEntry;
  style: LogStyle;
}) {
  const time = entry.timestamp.toLocaleTimeString([], { hour12: false });
  const color =
    entry.level === 'ERROR' || entry.level === 'FATAL'
      ? 'red'
      : entry.level === 'WARN'
        ? 'yellow'
        : undefined;
  const fields =
    style === 'verbose' && entry.fields
      ? ` ${safeStringify(entry.fields)}`
      : '';
  return (
    <Text color={color} wrap="truncate-end">
      <Text dimColor>{time} </Text>
      <Text bold>{entry.level.padEnd(5)} </Text>
      {style === 'verbose' && entry.loggerName ? `[${entry.loggerName}] ` : ''}
      {singleLine(entry.message)}
      {singleLine(fields)}
    </Text>
  );
}

function resolveViewportEnd(
  entries: readonly CapturedLogEntry[],
  endSequence: number | null,
  visibleRows: number,
): number {
  if (endSequence === null) return entries.length;

  const pinnedIndex = entries.findIndex(
    (entry) => entry.sequence === endSequence,
  );
  if (pinnedIndex >= 0) return pinnedIndex + 1;

  // The bounded store may evict the pinned entry. Keep the viewport at the
  // oldest complete page instead of unexpectedly jumping back to the tail.
  const firstNewerIndex = entries.findIndex(
    (entry) => entry.sequence > endSequence,
  );
  if (firstNewerIndex >= 0)
    return Math.min(entries.length, Math.max(visibleRows, firstNewerIndex));
  return entries.length;
}

function singleLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable fields]';
  }
}

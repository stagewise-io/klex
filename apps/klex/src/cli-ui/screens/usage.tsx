import { Box, Text } from 'ink';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type {
  AdminApiClient,
  UsageDataPoint,
  UsageResponse,
} from '../api-client';
import { ActivityIndicator } from '../components/activity-indicator';
import { EmptyState } from '../components/empty-state';
import { KeyHint } from '../components/key-hint';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface UsageScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

interface UsageTableCell {
  content: ReactNode;
  align?: 'left' | 'right';
}

function UsageTableRow({ cells }: { cells: UsageTableCell[] }) {
  return (
    <Box>
      <Text dimColor>│ </Text>
      {cells.map((cell, index) => (
        <Box key={USAGE_COLUMNS[index]?.key}>
          <Box
            width={USAGE_COLUMNS[index]?.width}
            justifyContent={cell.align === 'right' ? 'flex-end' : 'flex-start'}
            overflow="hidden"
          >
            {cell.content}
          </Box>
          <Text dimColor>{index === cells.length - 1 ? ' │' : ' │ '}</Text>
        </Box>
      ))}
    </Box>
  );
}

function UsageTableDivider({
  left,
  middle,
  right,
}: {
  left: string;
  middle: string;
  right: string;
}) {
  return (
    <Text dimColor>
      {left}
      {USAGE_COLUMNS.map(({ width }) => '─'.repeat(width + 2)).join(middle)}
      {right}
    </Text>
  );
}

function UsageTable({
  models,
  totals,
}: {
  models: ModelUsage[];
  totals: Omit<ModelUsage, 'modelId'>;
}) {
  const header = [
    'Model',
    'Calls',
    'Input',
    'Output',
    'Cache W',
    'Cache R',
    'Errors',
  ];
  return (
    <Box marginTop={1} flexDirection="column">
      <UsageTableDivider left="╭" middle="┬" right="╮" />
      <UsageTableRow
        cells={header.map((label, index) => ({
          content: (
            <Text bold dimColor>
              {label}
            </Text>
          ),
          align: index === 0 ? 'left' : 'right',
        }))}
      />
      <UsageTableDivider left="├" middle="┼" right="┤" />
      {models.map((model) => (
        <UsageTableRow
          key={model.modelId}
          cells={[
            {
              content: <Text wrap="truncate-end">{model.modelId}</Text>,
            },
            { content: <Text>{model.callCount}</Text>, align: 'right' },
            {
              content: <Text>{formatTokens(model.inputTokens)}</Text>,
              align: 'right',
            },
            {
              content: <Text>{formatTokens(model.outputTokens)}</Text>,
              align: 'right',
            },
            {
              content: (
                <Text dimColor>
                  {formatTokens(model.inputCacheWriteTokens)}
                </Text>
              ),
              align: 'right',
            },
            {
              content: (
                <Text dimColor>{formatTokens(model.inputCacheReadTokens)}</Text>
              ),
              align: 'right',
            },
            {
              content: (
                <Text color={model.errorCount > 0 ? 'red' : undefined}>
                  {model.errorCount}
                </Text>
              ),
              align: 'right',
            },
          ]}
        />
      ))}
      <UsageTableDivider left="├" middle="┼" right="┤" />
      <UsageTableRow
        cells={[
          { content: <Text bold>Total</Text> },
          { content: <Text bold>{totals.callCount}</Text>, align: 'right' },
          {
            content: <Text bold>{formatTokens(totals.inputTokens)}</Text>,
            align: 'right',
          },
          {
            content: <Text bold>{formatTokens(totals.outputTokens)}</Text>,
            align: 'right',
          },
          {
            content: (
              <Text bold dimColor>
                {formatTokens(totals.inputCacheWriteTokens)}
              </Text>
            ),
            align: 'right',
          },
          {
            content: (
              <Text bold dimColor>
                {formatTokens(totals.inputCacheReadTokens)}
              </Text>
            ),
            align: 'right',
          },
          {
            content: (
              <Text bold color={totals.errorCount > 0 ? 'red' : undefined}>
                {totals.errorCount}
              </Text>
            ),
            align: 'right',
          },
        ]}
      />
      <UsageTableDivider left="╰" middle="┴" right="╯" />
    </Box>
  );
}

type Timeframe = 'today' | '24h' | '7d' | '30d' | 'all';
type Granularity = 'hourly' | 'daily' | 'weekly';

const USAGE_COLUMNS = [
  { key: 'model', width: 28 },
  { key: 'calls', width: 6 },
  { key: 'input', width: 8 },
  { key: 'output', width: 8 },
  { key: 'cache-write', width: 8 },
  { key: 'cache-read', width: 8 },
  { key: 'errors', width: 6 },
] as const;

const TIMEFRAMES: { key: Timeframe; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: 'Last 24h' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];

interface ModelUsage {
  modelId: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  inputCacheWriteTokens: number;
  inputCacheReadTokens: number;
  errorCount: number;
}

function aggregateByModel(dataPoints: UsageDataPoint[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const dp of dataPoints) {
    const key = dp.splitKey ?? dp.modelId ?? 'unknown';
    const existing = map.get(key);
    if (existing) {
      existing.callCount += dp.callCount;
      existing.inputTokens += dp.inputTokens;
      existing.outputTokens += dp.outputTokens;
      existing.inputCacheWriteTokens += dp.inputCacheWriteTokens;
      existing.inputCacheReadTokens += dp.inputCacheReadTokens;
      existing.errorCount += dp.errorCount;
    } else {
      map.set(key, {
        modelId: key,
        callCount: dp.callCount,
        inputTokens: dp.inputTokens,
        outputTokens: dp.outputTokens,
        inputCacheWriteTokens: dp.inputCacheWriteTokens,
        inputCacheReadTokens: dp.inputCacheReadTokens,
        errorCount: dp.errorCount,
      });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getFromDate(timeframe: Timeframe): string | undefined {
  const now = new Date();
  switch (timeframe) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return start.toISOString();
    }
    case '24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    case 'all':
      return undefined;
  }
}

/** Derive granularity from the selected timeframe. */
function granularityFor(timeframe: Timeframe): Granularity {
  switch (timeframe) {
    case 'today':
    case '24h':
      return 'hourly';
    case '7d':
    case '30d':
      return 'daily';
    case 'all':
      return 'weekly';
  }
}

function cycleValue<T extends string>(
  current: T,
  options: readonly { key: T; label: string }[],
): T {
  const idx = options.findIndex((o) => o.key === current);
  const nextIdx = (idx + 1) % options.length;
  return options[nextIdx]?.key ?? options[0]?.key ?? current;
}

export function UsageScreen({ apiClient, onBack }: UsageScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const [timeframe, setTimeframe] = useState<Timeframe>('7d');

  const from = useMemo(() => getFromDate(timeframe), [timeframe]);
  const granularity = useMemo(() => granularityFor(timeframe), [timeframe]);

  // Deps ensure immediate refetch when timeframe changes.
  const usagePoll = usePolling<UsageResponse>(
    () => apiClient.getUsage({ splitBy: 'model', from, granularity }),
    10000,
    [from, granularity],
  );

  useEffect(() => {
    if (usagePoll.error) {
      pushToast(`Failed to load usage: ${usagePoll.error.message}`, 'error');
    }
  }, [usagePoll.error, pushToast]);

  const cycleTimeframe = useCallback(
    () => setTimeframe((t) => cycleValue(t, TIMEFRAMES)),
    [],
  );

  useEffect(() => {
    setMeta({
      title: 'Token Usage',
      breadcrumb: ['Home'],
      keys: [
        { key: 't', label: 'Timeframe' },
        { key: 'r', label: 'Refresh' },
        { key: 'esc', label: 'Back' },
      ],
    });
  }, [setMeta]);

  useMenuInput({
    [MenuKeys.Back]: onBack,
    [MenuKeys.Refresh]: () => usagePoll.refresh(),
    t: cycleTimeframe,
  });

  const models = useMemo(
    () => aggregateByModel(usagePoll.data?.dataPoints ?? []),
    [usagePoll.data],
  );

  const totals = useMemo(
    () =>
      models.reduce(
        (acc, m) => ({
          callCount: acc.callCount + m.callCount,
          inputTokens: acc.inputTokens + m.inputTokens,
          outputTokens: acc.outputTokens + m.outputTokens,
          inputCacheWriteTokens:
            acc.inputCacheWriteTokens + m.inputCacheWriteTokens,
          inputCacheReadTokens:
            acc.inputCacheReadTokens + m.inputCacheReadTokens,
          errorCount: acc.errorCount + m.errorCount,
        }),
        {
          callCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          inputCacheWriteTokens: 0,
          inputCacheReadTokens: 0,
          errorCount: 0,
        },
      ),
    [models],
  );

  const timeframeLabel = TIMEFRAMES.find((t) => t.key === timeframe)?.label;

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        {/* Active filter display */}
        <Box gap={2}>
          <Box>
            <Text dimColor>Timeframe: </Text>
            <Text bold color="cyan">
              {timeframeLabel}
            </Text>
            <Text dimColor>
              {' '}
              <KeyHint keyName="t" />
            </Text>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text bold>Token Usage by Model</Text>
          {usagePoll.loading && <ActivityIndicator label="Loading usage..." />}
        </Box>

        {models.length === 0 && !usagePoll.loading && (
          <EmptyState>No usage data for this timeframe.</EmptyState>
        )}

        {models.length > 0 && <UsageTable models={models} totals={totals} />}
      </Box>
    </Box>
  );
}

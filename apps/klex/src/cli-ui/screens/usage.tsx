import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AdminApiClient,
  UsageDataPoint,
  UsageResponse,
} from '../api-client';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface UsageScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

type Timeframe = 'today' | '24h' | '7d' | '30d' | 'all';
type Granularity = 'hourly' | 'daily' | 'weekly';

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
            <Text dimColor> [t]</Text>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text bold>Token Usage by Model</Text>
          {usagePoll.loading && (
            <Text>
              {' '}
              <Spinner type="dots" />
            </Text>
          )}
        </Box>

        {models.length === 0 && !usagePoll.loading && (
          <Text dimColor>No usage data for this timeframe.</Text>
        )}

        {models.length > 0 && (
          <Box marginLeft={2} marginTop={1} flexDirection="column">
            {/* Header */}
            <Box>
              <Box width={30}>
                <Text bold dimColor>
                  Model
                </Text>
              </Box>
              <Box width={8}>
                <Text bold dimColor>
                  Calls
                </Text>
              </Box>
              <Box width={10}>
                <Text bold dimColor>
                  Input
                </Text>
              </Box>
              <Box width={10}>
                <Text bold dimColor>
                  Output
                </Text>
              </Box>
              <Box width={10}>
                <Text bold dimColor>
                  Cache W
                </Text>
              </Box>
              <Box width={10}>
                <Text bold dimColor>
                  Cache R
                </Text>
              </Box>
              <Box width={8}>
                <Text bold dimColor>
                  Errors
                </Text>
              </Box>
            </Box>

            {/* Rows */}
            {models.map((m) => (
              <Box key={m.modelId}>
                <Box width={30}>
                  <Text>{m.modelId}</Text>
                </Box>
                <Box width={8}>
                  <Text>{m.callCount}</Text>
                </Box>
                <Box width={10}>
                  <Text>{formatTokens(m.inputTokens)}</Text>
                </Box>
                <Box width={10}>
                  <Text>{formatTokens(m.outputTokens)}</Text>
                </Box>
                <Box width={10}>
                  <Text dimColor>{formatTokens(m.inputCacheWriteTokens)}</Text>
                </Box>
                <Box width={10}>
                  <Text dimColor>{formatTokens(m.inputCacheReadTokens)}</Text>
                </Box>
                <Box width={8}>
                  <Text color={m.errorCount > 0 ? 'red' : undefined}>
                    {m.errorCount}
                  </Text>
                </Box>
              </Box>
            ))}

            {/* Totals */}
            <Box marginTop={1}>
              <Box width={30}>
                <Text bold>Total</Text>
              </Box>
              <Box width={8}>
                <Text bold>{totals.callCount}</Text>
              </Box>
              <Box width={10}>
                <Text bold>{formatTokens(totals.inputTokens)}</Text>
              </Box>
              <Box width={10}>
                <Text bold>{formatTokens(totals.outputTokens)}</Text>
              </Box>
              <Box width={10}>
                <Text bold dimColor>
                  {formatTokens(totals.inputCacheWriteTokens)}
                </Text>
              </Box>
              <Box width={10}>
                <Text bold dimColor>
                  {formatTokens(totals.inputCacheReadTokens)}
                </Text>
              </Box>
              <Box width={8}>
                <Text bold color={totals.errorCount > 0 ? 'red' : undefined}>
                  {totals.errorCount}
                </Text>
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}

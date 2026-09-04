import { Box, Text } from 'ink';

import type { CloudStatus } from '../api-client';

export interface GlobalHeaderProps {
  screenTitle: string;
  breadcrumb: string[];
  cloud: CloudStatus | null;
  loading: boolean;
  width?: number;
}

export function GlobalHeader({
  screenTitle,
  breadcrumb,
  width,
}: GlobalHeaderProps) {
  const availableWidth = width ?? 80;
  const context = [...breadcrumb, screenTitle].join(' › ');

  return (
    <Box flexDirection="column" flexShrink={0} width={width} paddingX={1}>
      <Box gap={2}>
        <Text bold color="blue">
          Klex Bot
        </Text>
        <Text dimColor>
          {truncate(context, Math.max(availableWidth - 13, 12))}
        </Text>
      </Box>
      <Text dimColor>{'─'.repeat(Math.max(availableWidth - 2, 1))}</Text>
    </Box>
  );
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(maxLength - 1, 1))}…`;
}

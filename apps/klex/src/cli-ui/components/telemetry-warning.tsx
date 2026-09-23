import { Box, Text } from 'ink';

import type { TelemetryWarning as TelemetryWarningNotice } from '@/telemetry-config';

export interface TelemetryWarningProps {
  warning: TelemetryWarningNotice;
}

export function TelemetryWarning({ warning }: TelemetryWarningProps) {
  if (warning.mode === 'debug') {
    return (
      <Box
        borderColor="red"
        borderStyle="double"
        flexDirection="column"
        flexShrink={0}
        marginX={1}
        paddingX={1}
      >
        <Text backgroundColor="red" color="white" bold>
          {` ${warning.title} `}
        </Text>
        {warning.lines.map((line) => (
          <Text key={line} color="red" bold>
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box
      borderColor="yellow"
      borderStyle="round"
      flexDirection="column"
      flexShrink={0}
      marginX={1}
      paddingX={1}
    >
      <Text color="yellow" bold>
        {warning.title}
      </Text>
      <Text color="yellow">{warning.lines.join(' ')}</Text>
    </Box>
  );
}

import { Box, Text } from 'ink';

export function TelemetryWarning() {
  return (
    <Box
      borderColor="yellow"
      borderStyle="round"
      flexShrink={0}
      marginX={1}
      paddingX={1}
    >
      <Text color="yellow" bold>
        WARNING: Debug tracing is enabled. Chat content and detailed telemetry
        may be collected.
      </Text>
    </Box>
  );
}

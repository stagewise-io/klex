import { Box, Text, useStdout } from 'ink';
import type { ReactNode } from 'react';

export function ScreenSection({
  title,
  children,
  tone = 'blue',
}: {
  title: string;
  children: ReactNode;
  tone?: 'blue' | 'yellow';
}) {
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns || 80;
  const width = Math.max(terminalWidth - (terminalWidth >= 80 ? 4 : 0), 1);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor={tone}
      paddingX={1}
    >
      <Text bold color={tone}>
        {title}
      </Text>
      <Text dimColor>{`─`.repeat(Math.max(width - 4, 1))}</Text>
      {children}
    </Box>
  );
}

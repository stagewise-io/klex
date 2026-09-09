import { Box, type BoxProps } from 'ink';
import type { ReactNode } from 'react';

export type InsetPanelTone = 'neutral' | 'active' | 'warning' | 'error';

const TONE_COLORS: Record<InsetPanelTone, BoxProps['borderColor']> = {
  neutral: 'gray',
  active: 'blue',
  warning: 'yellow',
  error: 'red',
};

export interface InsetPanelProps
  extends Pick<
    BoxProps,
    | 'height'
    | 'width'
    | 'overflow'
    | 'marginTop'
    | 'marginBottom'
    | 'flexDirection'
  > {
  children: ReactNode;
  tone?: InsetPanelTone;
}

export function InsetPanel({
  children,
  tone = 'neutral',
  ...boxProps
}: InsetPanelProps) {
  return (
    <Box
      borderStyle="round"
      borderColor={TONE_COLORS[tone]}
      paddingX={1}
      marginTop={1}
      flexDirection="column"
      {...boxProps}
    >
      {children}
    </Box>
  );
}

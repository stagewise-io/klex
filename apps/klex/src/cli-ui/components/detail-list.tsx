import { Box, Text } from 'ink';
import { createContext, type ReactNode, useContext } from 'react';

const DetailLabelWidthContext = createContext(16);

export function DetailList({
  children,
  labelWidth = 16,
}: {
  children: ReactNode;
  labelWidth?: number;
}) {
  return (
    <DetailLabelWidthContext.Provider value={labelWidth}>
      <Box flexDirection="column">{children}</Box>
    </DetailLabelWidthContext.Provider>
  );
}

export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const labelWidth = useContext(DetailLabelWidthContext);
  return (
    <Box>
      <Box width={labelWidth}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{children}</Text>
    </Box>
  );
}

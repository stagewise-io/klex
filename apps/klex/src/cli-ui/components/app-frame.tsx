import { Box, useStdout } from 'ink';
import type { ReactNode } from 'react';

import type { CloudStatus, SessionInfo } from '../api-client';
import type { Toast } from '../hooks/use-toast';
import { GlobalFooter } from './global-footer';
import { GlobalHeader } from './global-header';
import { ToastStack } from './toast';

export interface AppFrameProps {
  screenTitle: string;
  breadcrumb: string[];
  keys: { key: string; label: string }[];
  sessions: SessionInfo[];
  cloud: CloudStatus | null;
  loading: boolean;
  toasts: Toast[];
  onDismissToast: (id: number) => void;
  children: ReactNode;
}

export function AppFrame({
  screenTitle,
  breadcrumb,
  keys,
  sessions,
  cloud,
  loading,
  toasts,
  onDismissToast,
  children,
}: AppFrameProps) {
  const { stdout } = useStdout();
  const terminalHeight = stdout.rows || 24;
  const terminalWidth = stdout.columns || 80;

  return (
    <Box flexDirection="column" height={terminalHeight} width={terminalWidth}>
      <GlobalHeader
        screenTitle={screenTitle}
        breadcrumb={breadcrumb}
        cloud={cloud}
        loading={loading}
        width={terminalWidth}
      />
      <Box
        position="relative"
        flexDirection="column"
        flexGrow={1}
        justifyContent="center"
        paddingX={terminalWidth >= 80 ? 2 : 0}
        width={terminalWidth}
      >
        {children}
        {toasts.length > 0 ? (
          <Box
            position="absolute"
            bottom={0}
            width={terminalWidth >= 80 ? terminalWidth - 4 : terminalWidth}
          >
            <ToastStack toasts={toasts} onDismiss={onDismissToast} />
          </Box>
        ) : null}
      </Box>
      <Box>
        <GlobalFooter
          keys={keys}
          sessions={sessions}
          cloud={cloud}
          loading={loading}
          toastCount={toasts.length}
          width={terminalWidth}
        />
      </Box>
    </Box>
  );
}

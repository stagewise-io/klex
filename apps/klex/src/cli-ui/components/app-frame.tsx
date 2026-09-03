import { Box } from 'ink';
import type { ReactNode } from 'react';

import type { CloudStatus, SessionInfo } from '../api-client';
import { GlobalFooter } from './global-footer';
import { GlobalHeader } from './global-header';

export interface AppFrameProps {
  screenTitle: string;
  breadcrumb: string[];
  keys: { key: string; label: string }[];
  sessions: SessionInfo[];
  cloud: CloudStatus | null;
  loading: boolean;
  toastCount: number;
  children: ReactNode;
}

export function AppFrame({
  screenTitle,
  breadcrumb,
  keys,
  sessions,
  cloud,
  loading,
  toastCount,
  children,
}: AppFrameProps) {
  return (
    <Box flexDirection="column" height="100%">
      <GlobalHeader
        screenTitle={screenTitle}
        breadcrumb={breadcrumb}
        sessions={sessions}
        cloud={cloud}
        loading={loading}
      />
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {children}
      </Box>
      <Box marginTop={1}>
        <GlobalFooter
          keys={keys}
          sessions={sessions}
          cloud={cloud}
          loading={loading}
          toastCount={toastCount}
        />
      </Box>
    </Box>
  );
}

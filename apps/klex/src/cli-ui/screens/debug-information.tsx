import { Box, Text } from 'ink';
import { useEffect } from 'react';

import { KLEX_VERSION } from '@/release';

import type { CloudStatus } from '../api-client';
import { DetailList, DetailRow } from '../components/detail-list';
import { ScreenSection } from '../components/screen-section';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { MenuKeys, useMenuInput } from '../menu-keys';

export function DebugInformationScreen({
  dataDirectory,
  cloud,
  dangerousLocalAdminApiPort,
  onBack,
}: {
  dataDirectory: string;
  cloud: CloudStatus | null;
  dangerousLocalAdminApiPort: number | undefined;
  onBack: () => void;
}) {
  const { setMeta } = useScreenMeta();

  useEffect(() => {
    setMeta({
      title: 'Debug Information',
      breadcrumb: ['Home', 'Settings'],
      keys: [{ key: 'esc', label: 'Back' }],
    });
  }, [setMeta]);

  useMenuInput({ [MenuKeys.Back]: onBack });

  return (
    <ScreenSection title="Runtime">
      <DetailList labelWidth={20}>
        <DetailRow label="Klex version">{KLEX_VERSION}</DetailRow>
        <DetailRow label="Node.js">{process.version}</DetailRow>
        <DetailRow label="Platform">
          {process.platform} {process.arch}
        </DetailRow>
        <DetailRow label="Data directory">{dataDirectory}</DetailRow>
        <DetailRow label="Local Admin API">
          {dangerousLocalAdminApiPort === undefined
            ? 'internal only'
            : `http://127.0.0.1:${dangerousLocalAdminApiPort}`}
        </DetailRow>
      </DetailList>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Cloud</Text>
        <DetailList labelWidth={20}>
          <DetailRow label="Enabled">
            {cloud?.cloudEnabled ? 'yes' : 'no'}
          </DetailRow>
          <DetailRow label="Enrolled">
            {cloud?.enrolled ? 'yes' : 'no'}
          </DetailRow>
          <DetailRow label="Enrollment ID">
            {cloud?.clientId ?? 'not available'}
          </DetailRow>
          <DetailRow label="Cloud URL">
            {cloud?.cloudBaseUrl ?? 'not available'}
          </DetailRow>
          <DetailRow label="Tunnel status">
            {cloud?.tunnelState ?? 'not available'}
          </DetailRow>
        </DetailList>
      </Box>
    </ScreenSection>
  );
}

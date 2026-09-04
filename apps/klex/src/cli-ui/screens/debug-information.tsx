import { Box, Text } from 'ink';
import { useEffect } from 'react';

import { KLEX_VERSION } from '@/release';

import type { CloudStatus } from '../api-client';
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
      <Row label="Klex version" value={KLEX_VERSION} />
      <Row label="Node.js" value={process.version} />
      <Row label="Platform" value={`${process.platform} ${process.arch}`} />
      <Row label="Data directory" value={dataDirectory} />
      <Row
        label="Local Admin API"
        value={
          dangerousLocalAdminApiPort === undefined
            ? 'internal only'
            : `http://127.0.0.1:${dangerousLocalAdminApiPort}`
        }
      />
      <Box marginTop={1} flexDirection="column">
        <Text bold>Cloud</Text>
        <Row label="Enabled" value={cloud?.cloudEnabled ? 'yes' : 'no'} />
        <Row label="Enrolled" value={cloud?.enrolled ? 'yes' : 'no'} />
        <Row label="Enrollment ID" value={cloud?.clientId ?? 'not available'} />
        <Row label="Cloud URL" value={cloud?.cloudBaseUrl ?? 'not available'} />
        <Row
          label="Tunnel status"
          value={cloud?.tunnelState ?? 'not available'}
        />
      </Box>
    </ScreenSection>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={20}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

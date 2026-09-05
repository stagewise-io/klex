import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { useEffect } from 'react';

import { ScreenSection } from '../components/screen-section';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface SettingsScreenProps {
  dataDirectory: string;
  onOpenAgentIdentity: () => void;
  onOpenProviders: () => void;
  onOpenCloud: () => void;
  onOpenMcp: () => void;
  onOpenModelSelection: () => void;
  onOpenTelemetry: () => void;
  onOpenDebugInformation: () => void;
  onOpenLogs: () => void;
  onOpenGodMessages: () => void;
  onBack: () => void;
}

interface MenuItem {
  label: string;
  value: string;
}

const MENU_ITEMS: MenuItem[] = [
  { label: 'Agent Identity', value: 'agent-identity' },
  { label: 'Cloud', value: 'cloud' },
  { label: 'Providers & Endpoints', value: 'providers' },
  { label: 'MCP Servers', value: 'mcp' },
  { label: 'Model Selection', value: 'model-selection' },
  { label: 'Telemetry', value: 'telemetry' },
  { label: 'Debug Information', value: 'debug-information' },
  { label: 'Logs', value: 'logs' },
  { label: 'God Messages', value: 'god-messages' },
];

export function SettingsScreen({
  dataDirectory,
  onOpenAgentIdentity,
  onOpenProviders,
  onOpenCloud,
  onOpenMcp,
  onOpenModelSelection,
  onOpenTelemetry,
  onOpenDebugInformation,
  onOpenLogs,
  onOpenGodMessages,
  onBack,
}: SettingsScreenProps) {
  const { setMeta } = useScreenMeta();

  useEffect(() => {
    setMeta({
      title: 'Settings',
      breadcrumb: ['Home'],
      keys: [
        { key: '↑↓', label: 'Navigate' },
        { key: 'enter', label: 'Select' },
        { key: 'esc', label: 'Back' },
      ],
    });
  }, [setMeta]);

  useMenuInput({
    [MenuKeys.Back]: onBack,
  });

  const handleSelect = (item: MenuItem) => {
    switch (item.value) {
      case 'agent-identity':
        onOpenAgentIdentity();
        break;
      case 'cloud':
        onOpenCloud();
        break;
      case 'providers':
        onOpenProviders();
        break;
      case 'mcp':
        onOpenMcp();
        break;
      case 'model-selection':
        onOpenModelSelection();
        break;
      case 'telemetry':
        onOpenTelemetry();
        break;
      case 'debug-information':
        onOpenDebugInformation();
        break;
      case 'logs':
        onOpenLogs();
        break;
      case 'god-messages':
        onOpenGodMessages();
        break;
    }
  };

  return (
    <ScreenSection title="Configure your Klex Bot">
      <Text dimColor>Manage connectivity, models, tools, and diagnostics.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Agent data directory</Text>
        <Text>{dataDirectory}</Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput items={MENU_ITEMS} onSelect={handleSelect} />
      </Box>
    </ScreenSection>
  );
}

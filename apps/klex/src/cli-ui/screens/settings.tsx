import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { useEffect } from 'react';

import { useScreenMeta } from '../hooks/use-screen-meta';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface SettingsScreenProps {
  onOpenProviders: () => void;
  onOpenMcp: () => void;
  onOpenModelSelection: () => void;
  onOpenTelemetry: () => void;
  onBack: () => void;
}

interface MenuItem {
  label: string;
  value: string;
}

const MENU_ITEMS: MenuItem[] = [
  { label: 'Providers & Endpoints', value: 'providers' },
  { label: 'MCP Servers', value: 'mcp' },
  { label: 'Model Selection', value: 'model-selection' },
  { label: 'Telemetry', value: 'telemetry' },
];

export function SettingsScreen({
  onOpenProviders,
  onOpenMcp,
  onOpenModelSelection,
  onOpenTelemetry,
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
    }
  };

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Text dimColor>Select a category:</Text>
        <SelectInput items={MENU_ITEMS} onSelect={handleSelect} />
      </Box>
    </Box>
  );
}

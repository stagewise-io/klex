import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  type TelemetrySettings,
} from '../api-client';
import { ActivityIndicator } from '../components/activity-indicator';
import { type MenuItem, MenuList } from '../components/menu-list';
import { ScreenSection } from '../components/screen-section';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface TelemetryScreenProps {
  apiClient: AdminApiClient;
  debugTracingEnabled: boolean;
  onBack: () => void;
}

type TelemetryLevel = 'no' | 'basic' | 'advanced';

const LEVELS: Array<{
  value: TelemetryLevel;
  label: string;
  description: string;
}> = [
  {
    value: 'no',
    label: 'No telemetry',
    description: 'Disables remote telemetry and performance sampling.',
  },
  {
    value: 'basic',
    label: 'Basic telemetry',
    description:
      'Reports anonymous operational health and aggregate usage metrics.',
  },
  {
    value: 'advanced',
    label: 'Advanced telemetry',
    description:
      'Adds detailed performance traces without chat content or message text.',
  },
];

function isTelemetryLevel(value: string): value is TelemetryLevel {
  return value === 'no' || value === 'basic' || value === 'advanced';
}

export function TelemetryScreen({
  apiClient,
  debugTracingEnabled,
  onBack,
}: TelemetryScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const [settings, setSettings] = useState<TelemetrySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<TelemetryLevel | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    // Reading the attempt value makes retry an explicit effect trigger.
    void loadAttempt;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    apiClient
      .getTelemetry()
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof AdminApiClientError
            ? error.message
            : 'Failed to load telemetry settings';
        setLoadError(message);
        pushToast(message, 'error');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient, loadAttempt, pushToast]);

  const level =
    settings && isTelemetryLevel(settings.level) ? settings.level : null;
  const selectedIndex = Math.max(
    0,
    LEVELS.findIndex((item) => item.value === level),
  );
  const selectedDescription =
    LEVELS[selectedIndex]?.description ?? 'Select a telemetry level.';
  const effectiveLevel = debugTracingEnabled ? 'advanced' : level;
  const items = useMemo<MenuItem<TelemetryLevel>[]>(
    () => LEVELS.map(({ value, label }) => ({ value, label })),
    [],
  );

  useEffect(() => {
    setMeta({
      title: 'Telemetry',
      breadcrumb: ['Home', 'Settings'],
      keys: loading
        ? [{ key: 'esc', label: 'Back' }]
        : [
            { key: '↑↓', label: 'Navigate' },
            { key: 'enter', label: 'Save' },
            ...(loadError ? [{ key: 'r', label: 'Retry' }] : []),
            { key: 'esc', label: 'Back' },
          ],
    });
  }, [loadError, loading, setMeta]);

  useMenuInput({
    [MenuKeys.Back]: onBack,
    r: () => {
      if (!loading && !settings) setLoadAttempt((attempt) => attempt + 1);
    },
  });

  async function saveLevel(item: MenuItem<TelemetryLevel>) {
    if (saving || item.value === level) return;
    setSaving(item.value);
    try {
      const updated = await apiClient.patchTelemetry({ level: item.value });
      setSettings(updated);
      pushToast(`${item.label} enabled`, 'info');
    } catch (error: unknown) {
      pushToast(
        error instanceof AdminApiClientError
          ? error.message
          : 'Failed to update telemetry settings',
        'error',
      );
    } finally {
      setSaving(null);
    }
  }

  if (loading && !settings) {
    return (
      <ScreenSection title="Telemetry">
        <ActivityIndicator label="Loading telemetry settings..." />
      </ScreenSection>
    );
  }

  return (
    <ScreenSection title="Telemetry">
      {!settings ? (
        <Text color="red">
          {loadError ?? 'Telemetry settings unavailable.'}
        </Text>
      ) : null}
      {settings ? (
        <>
          <Text dimColor>
            Choose what Klex reports. Chat content, message text, and
            authentication tokens are excluded unless debug tracing is
            explicitly enabled at startup.
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Anonymous instance ID</Text>
            <Text>{settings.instanceId ?? 'Unavailable'}</Text>
            <Text dimColor>
              Read-only identifier used to distinguish this installation in
              exported telemetry.
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Telemetry level</Text>
            <MenuList
              items={items}
              selectedIndex={selectedIndex}
              isFocused={!saving && Boolean(settings) && !debugTracingEnabled}
              onSelect={
                debugTracingEnabled ? undefined : (item) => void saveLevel(item)
              }
            />
            <Box marginTop={1} flexDirection="column">
              <Text>{selectedDescription}</Text>
              {saving ? <Text dimColor>Saving...</Text> : null}
              {debugTracingEnabled ? (
                <Text color="yellow">
                  Changes are ignored while debug tracing is active. Effective
                  level: Advanced (temporary).
                </Text>
              ) : null}
            </Box>
          </Box>
        </>
      ) : null}
      {debugTracingEnabled ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow" bold>
            Debug tracing is active for this process.
          </Text>
          <Text dimColor>
            It is startup-only, temporarily forces Advanced telemetry, and may
            collect chat content and detailed traces. Admin API level changes
            are ignored until debug tracing is disabled.
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>
            Debug tracing is startup-only and cannot be enabled from this
            screen.
          </Text>
        </Box>
      )}
    </ScreenSection>
  );
}

import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';

import { type AdminApiClient, AdminApiClientError } from '../api-client';
import { ScreenSection } from '../components/screen-section';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface GodMessagesScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

type Mode = 'overview' | 'input' | 'sending';

export function GodMessagesScreen({
  apiClient,
  onBack,
}: GodMessagesScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<Mode>('overview');
  const [message, setMessage] = useState('');

  useEffect(() => {
    setActive(mode === 'input');
  }, [mode, setActive]);

  useEffect(() => {
    setMeta({
      title:
        mode === 'input' || mode === 'sending'
          ? 'Send God Message'
          : 'God Messages',
      breadcrumb: ['Home', 'Settings'],
      keys:
        mode === 'input' || mode === 'sending'
          ? [
              { key: 'enter', label: 'Send' },
              { key: 'esc', label: 'Cancel' },
            ]
          : [
              { key: 'g', label: 'Compose' },
              { key: 'esc', label: 'Back' },
            ],
    });
  }, [setMeta, mode]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'overview') onBack();
      else if (mode === 'input') setMode('overview');
    },
    [MenuKeys.GodMessages]: () => {
      if (mode === 'overview') setMode('input');
    },
  });

  // --- Compose / sending mode ---

  if (mode === 'input' || mode === 'sending') {
    return (
      <ScreenSection title="Send God Message" tone="yellow">
        <Text dimColor>
          Type your message and press Enter to send. Press Esc to cancel.
        </Text>
        <Box marginTop={1}>
          {mode === 'sending' ? (
            <Text>
              <Spinner type="dots" /> Sending...
            </Text>
          ) : (
            <Text>
              Message:{' '}
              <TextInput
                value={message}
                onChange={setMessage}
                placeholder="Type your god message..."
                onSubmit={async () => {
                  if (!message.trim()) return;
                  setMode('sending');
                  try {
                    const result = await apiClient.sendGodMessage(
                      message.trim(),
                    );
                    pushToast(
                      `God message sent to session ${result.sessionId.slice(0, 8)}`,
                      'info',
                    );
                    setMessage('');
                    setMode('overview');
                  } catch (err) {
                    pushToast(
                      err instanceof AdminApiClientError
                        ? err.message
                        : 'Failed to send god message',
                      'error',
                    );
                    setMode('overview');
                  }
                }}
                showCursor
              />
            </Text>
          )}
        </Box>
      </ScreenSection>
    );
  }

  // --- Overview mode with disclaimer ---

  return (
    <ScreenSection title="God Messages" tone="yellow">
      <Box flexDirection="column" gap={1}>
        <Text bold color="yellow">
          ⚠ Disclaimer
        </Text>
        <Text>
          God messages are a powerful tool to communicate a command or
          directional guidance outside of the limits of other sessions.
        </Text>
        <Text dimColor>
          Messages sent here are injected into a dedicated session that trusts
          and prioritizes them above all other input. The agent will treat them
          as authoritative directives from its controller and act immediately.
        </Text>
        <Box marginTop={1}>
          <Text>
            Press{' '}
            <Text bold color="yellow">
              [g]
            </Text>{' '}
            to compose a god message.
          </Text>
        </Box>
      </Box>
    </ScreenSection>
  );
}

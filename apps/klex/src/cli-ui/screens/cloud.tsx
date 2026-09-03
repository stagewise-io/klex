import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  type CloudStatus,
} from '../api-client';
import { StatusBadge } from '../components/status-badge';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface CloudScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

type Mode = 'overview' | 'enroll-input' | 'enrolling';

export function CloudScreen({ apiClient, onBack }: CloudScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<Mode>('overview');
  const [enrollCode, setEnrollCode] = useState('');

  const statusPoll = usePolling<CloudStatus>(
    () => apiClient.getCloudStatus(),
    5000,
  );

  useEffect(() => {
    if (statusPoll.error) {
      pushToast(
        `Failed to load cloud status: ${statusPoll.error.message}`,
        'error',
      );
    }
  }, [statusPoll.error, pushToast]);

  useEffect(() => {
    setActive(mode === 'enroll-input');
  }, [mode, setActive]);

  useEffect(() => {
    const cloudEnabled = statusPoll.data?.cloudEnabled ?? false;
    const canEnroll =
      statusPoll.data !== null && cloudEnabled && !statusPoll.data.enrolled;

    setMeta({
      title:
        mode === 'enroll-input' || mode === 'enrolling'
          ? 'Cloud Enrollment'
          : 'Cloud',
      breadcrumb: ['Home'],
      keys:
        mode === 'enroll-input' || mode === 'enrolling'
          ? [
              { key: 'enter', label: 'Enroll' },
              { key: 'esc', label: 'Cancel' },
            ]
          : [
              ...(canEnroll ? [{ key: 'c', label: 'Enroll' }] : []),
              { key: 'esc', label: 'Back' },
            ],
    });
  }, [setMeta, mode, statusPoll.data]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'overview') onBack();
      else setMode('overview');
    },
    [MenuKeys.Cloud]: () => {
      if (
        mode === 'overview' &&
        statusPoll.data &&
        statusPoll.data.cloudEnabled &&
        !statusPoll.data.enrolled
      ) {
        setMode('enroll-input');
      }
    },
  });

  // --- Enroll input mode ---

  if (mode === 'enroll-input' || mode === 'enrolling') {
    return (
      <Box flexDirection="column">
        <Box marginTop={1} flexDirection="column">
          <Text>Paste your enrollment code below:</Text>
          <Text dimColor>
            The code was generated when you added a new agent in the cloud UI.
          </Text>
        </Box>
        <Box marginTop={1}>
          {mode === 'enrolling' ? (
            <Text>
              <Spinner type="dots" /> Enrolling...
            </Text>
          ) : (
            <Text>
              Code:{' '}
              <TextInput
                value={enrollCode}
                onChange={setEnrollCode}
                placeholder="Paste enrollment code..."
                onSubmit={async () => {
                  if (!enrollCode.trim()) return;
                  setMode('enrolling');
                  try {
                    const result = await apiClient.enroll(enrollCode.trim());
                    pushToast(
                      `Enrolled successfully! Client ID: ${result.clientId}`,
                      'info',
                    );
                    setEnrollCode('');
                    statusPoll.refresh();
                    setMode('overview');
                  } catch (err) {
                    pushToast(
                      err instanceof AdminApiClientError
                        ? err.message
                        : 'Enrollment failed',
                      'error',
                    );
                    setMode('overview');
                  } finally {
                    setMode('overview');
                  }
                }}
                showCursor
              />
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  // --- Overview mode ---

  const status = statusPoll.data;

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        {statusPoll.loading && !status && <Text dimColor>Loading...</Text>}

        {status && (
          <>
            <Box>
              <Text dimColor>Cloud enabled: </Text>
              <StatusBadge
                status={status.cloudEnabled ? 'ok' : 'idle'}
                label={status.cloudEnabled ? 'yes' : 'no'}
              />
            </Box>
            <Box>
              <Text dimColor>Enrolled: </Text>
              <StatusBadge
                status={status.enrolled ? 'ok' : 'warn'}
                label={status.enrolled ? 'yes' : 'no'}
              />
            </Box>
            <Text dimColor>Cloud URL: {status.cloudBaseUrl}</Text>

            {status.enrolled ? (
              <Box marginTop={1} flexDirection="column">
                <Text bold>Enrollment Details</Text>
                <Text dimColor> Client ID: {status.clientId}</Text>
                <Text dimColor> Enrolled at: {status.enrolledAt}</Text>
                <Box marginTop={1} flexDirection="column">
                  <Text bold>Tunnel Connection</Text>
                  <Box marginLeft={2}>
                    <Text dimColor>state: </Text>
                    <StatusBadge
                      status={
                        status.tunnelState === 'connected'
                          ? 'ok'
                          : status.tunnelState === 'connecting'
                            ? 'warn'
                            : status.tunnelState === 'error'
                              ? 'error'
                              : 'idle'
                      }
                      label={
                        status.tunnelState === 'connected'
                          ? 'connected'
                          : status.tunnelState === 'connecting'
                            ? 'connecting'
                            : status.tunnelState === 'error'
                              ? 'error — reconnecting'
                              : 'disconnected'
                      }
                    />
                  </Box>
                </Box>
              </Box>
            ) : status.cloudEnabled ? (
              <Box marginTop={1} flexDirection="column">
                <Text bold>How to enroll:</Text>
                <Box marginLeft={2} flexDirection="column">
                  <Text dimColor>
                    1. Open {status.cloudBaseUrl} in your browser
                  </Text>
                  <Text dimColor>2. Add a new agent</Text>
                  <Text dimColor>3. Copy the authentication code</Text>
                  <Text dimColor>4. Press [c] here and paste the code</Text>
                </Box>
              </Box>
            ) : (
              <Box marginTop={1} flexDirection="column">
                <Text bold>Cloud is disabled</Text>
                <Text dimColor>
                  Cloud connectivity is turned off. Enrollment is not available.
                </Text>
                <Box marginLeft={2} marginTop={1} flexDirection="column">
                  <Text dimColor>
                    To enable: remove --no-cloud flag or unset KLEX_NO_CLOUD
                  </Text>
                </Box>
              </Box>
            )}

            {status.cloudEnabled && (
              <Box marginTop={1} flexDirection="column">
                <Text bold>Opt out of cloud:</Text>
                <Box marginLeft={2} flexDirection="column">
                  <Text dimColor>Run klex with --no-cloud flag</Text>
                  <Text dimColor>
                    Or set KLEX_NO_CLOUD=1 environment variable
                  </Text>
                </Box>
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

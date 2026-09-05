import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { UpdateManager, UpdateState } from '@/self-update';

import { useTextInputActive } from '../hooks/use-text-input-active';

type UpdateBannerManager = Pick<
  UpdateManager,
  'getState' | 'install' | 'subscribe'
>;

export function UpdateBanner({
  activeSessionCount,
  inputBlocked = false,
  manager,
}: {
  activeSessionCount: number;
  inputBlocked?: boolean;
  manager: UpdateBannerManager;
}) {
  const state = useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getState(),
    () => manager.getState(),
  );
  const { active } = useTextInputActive();
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  const [confirmingVersion, setConfirmingVersion] = useState<string>();
  const confirmingVersionRef = useRef<string | undefined>(undefined);
  const installRequestPending = useRef(false);
  const version = 'version' in state ? state.version : undefined;
  const dismissed = version !== undefined && version === dismissedVersion;
  const confirming =
    state.status === 'available' && confirmingVersion === state.version;

  useEffect(() => {
    if (state.status !== 'available') {
      confirmingVersionRef.current = undefined;
      setConfirmingVersion(undefined);
    }
  }, [state.status]);

  const requestInstall = () => {
    if (installRequestPending.current) return;
    installRequestPending.current = true;
    void manager.install().finally(() => {
      installRequestPending.current = false;
    });
  };

  useInput(
    (input) => {
      if (active || dismissed) return;
      const key = input.toLowerCase();
      if (key === 'u' && state.status === 'available') {
        if (
          activeSessionCount > 0 &&
          confirmingVersionRef.current !== state.version
        ) {
          confirmingVersionRef.current = state.version;
          setConfirmingVersion(state.version);
          return;
        }
        requestInstall();
      } else if (key === 'u' && state.status === 'failed') {
        requestInstall();
      } else if (
        key === 'n' &&
        state.status === 'available' &&
        confirmingVersionRef.current === state.version
      ) {
        confirmingVersionRef.current = undefined;
        setConfirmingVersion(undefined);
      } else if (
        key === 'n' &&
        version &&
        (state.status === 'available' || state.status === 'failed')
      ) {
        setDismissedVersion(version);
      }
    },
    { isActive: !inputBlocked },
  );

  if (dismissed || inputBlocked) return null;
  const message = confirming
    ? `${activeSessionCount} active session${activeSessionCount === 1 ? '' : 's'} will be interrupted. Press u again to update and restart.`
    : updateMessage(state);
  if (!message) return null;

  return (
    <Box
      borderStyle="single"
      borderColor={state.status === 'failed' ? 'red' : 'yellow'}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold>{message}</Text>
      {state.status === 'available' && !confirming ? (
        <Box gap={4}>
          <Text>[u] Update & restart</Text>
          <Text>[n] Dismiss for now</Text>
        </Box>
      ) : null}
      {confirming ? <Text>[n] Cancel</Text> : null}
      {state.status === 'failed' ? (
        <Box gap={4}>
          <Text>[u] Retry</Text>
          <Text>[n] Dismiss for now</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function updateMessage(state: UpdateState): string | undefined {
  switch (state.status) {
    case 'available':
      return `Klex ${state.version} is available.`;
    case 'installing':
      return `${state.message} (${state.version})…`;
    case 'failed':
      return `Update failed: ${state.message}`;
    case 'restarting':
      return `Klex ${state.version} installed. Restarting…`;
    default:
      return undefined;
  }
}

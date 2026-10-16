import { Box, render, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useState,
} from 'react';

import type { AgentDirectory, DiscoveredAgent } from '@/agent-directory';
import { AppFrame, EmptyState, type MenuItem, MenuList } from '@/cli-ui';
import { isDirectoryInUse } from '@/directory-lock';

export interface AgentPicker {
  choose(): Promise<string | undefined>;
}

function AgentChoiceList({
  items,
  onSelect,
}: {
  items: MenuItem<string>[];
  onSelect: (item: MenuItem<string>) => void;
}) {
  const { stdout } = useStdout();
  return (
    <MenuList
      items={items}
      initialIndex={Math.max(
        0,
        items.findIndex((item) => !item.disabled),
      )}
      visibleCount={Math.max(
        1,
        Math.min(items.length, 10, (stdout.rows || 24) - 10),
      )}
      onSelect={onSelect}
    />
  );
}

function PickerError({ message }: { message: string }) {
  return (
    <Box height={1} width="100%" overflow="hidden">
      <Text color="red" wrap="truncate-end">
        {message.replace(/\s+/g, ' ').trim()}
      </Text>
    </Box>
  );
}

export function createAgentPicker(deps: {
  agentDirectory: AgentDirectory;
  prepareAgent?: (directory: string) => Promise<boolean>;
  enrollCloud?: (directory: string, token: string) => Promise<void>;
  /** The user left the enrollment step with Escape. */
  onEnrollmentCancelled?: (directory: string) => void;
}): AgentPicker {
  return {
    choose: () => chooseAgent(deps),
  };
}

async function chooseAgent(deps: {
  agentDirectory: AgentDirectory;
  prepareAgent?: (directory: string) => Promise<boolean>;
  enrollCloud?: (directory: string, token: string) => Promise<void>;
  onEnrollmentCancelled?: (directory: string) => void;
}): Promise<string | undefined> {
  const agents = await deps.agentDirectory.discover();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (directory: string | undefined) => {
      if (settled) return;
      settled = true;
      instance?.unmount();
      resolve(directory);
    };

    const instance = render(
      <PickerSurface
        agents={agents}
        onComplete={finish}
        agentDirectory={deps.agentDirectory}
        prepareAgent={deps.prepareAgent}
        enrollCloud={deps.enrollCloud}
        onEnrollmentCancelled={deps.onEnrollmentCancelled}
      />,
      { exitOnCtrlC: false },
    );
  });
}

export function PickerSurface(props: ComponentProps<typeof PickerScreen>) {
  return <PickerScreen {...props} />;
}

function PickerFrame({
  title,
  keys,
  children,
}: {
  title: string;
  keys: { key: string; label: string }[];
  children: ReactNode;
}) {
  return (
    <AppFrame
      screenTitle={title}
      breadcrumb={title === 'Select a Klex Bot' ? [] : ['Bots']}
      keys={keys}
      sessions={[]}
      cloud={null}
      loading={false}
      toasts={[]}
      onDismissToast={() => {}}
      showRuntimeStatus={false}
    >
      <Box flexDirection="column">{children}</Box>
    </AppFrame>
  );
}

function PickerScreen({
  agents,
  onComplete,
  agentDirectory,
  prepareAgent,
  enrollCloud,
  onEnrollmentCancelled,
}: {
  agents: DiscoveredAgent[];
  onComplete: (directory: string | undefined) => void;
  agentDirectory: AgentDirectory;
  prepareAgent?: (directory: string) => Promise<boolean>;
  enrollCloud?: (directory: string, token: string) => Promise<void>;
  onEnrollmentCancelled?: (directory: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [enrolling, setEnrolling] = useState<string | undefined>();
  const [enrollmentToken, setEnrollmentToken] = useState('');
  const [enrollmentSubmitting, setEnrollmentSubmitting] = useState(false);

  useInput((input, key) => {
    if (key.escape) {
      // An in-flight request decides the outcome: cancelling here would
      // report an abort and then open the agent if the request succeeds.
      if (enrollmentSubmitting) return;
      setError(undefined);
      if (enrolling) {
        onEnrollmentCancelled?.(enrolling);
        setEnrolling(undefined);
      } else if (creating) setCreating(false);
      else onComplete(undefined);
    } else if (!creating && !enrolling && !key.ctrl && !key.meta) {
      if (input.toLowerCase() === 'q') onComplete(undefined);
      else if (input.toLowerCase() === 'a') {
        setError(undefined);
        setName('');
        setCreating(true);
      }
    }
  });

  useEffect(() => {
    if (!creating) return;
    // TextInput owns Enter handling; this effect only keeps the screen state
    // deterministic when switching back from a failed creation attempt.
    setError(undefined);
  }, [creating]);

  const selectDirectory = (directory: string) => {
    setError(undefined);
    void isDirectoryInUse(directory)
      .then((inUse) => {
        if (inUse) {
          setError('This agent is already started. Choose another agent.');
          return;
        }
        if (!prepareAgent) {
          onComplete(directory);
          return;
        }
        void prepareAgent(directory).then(
          (needsEnrollment) => {
            if (needsEnrollment && enrollCloud) {
              setEnrollmentToken('');
              setEnrollmentSubmitting(false);
              setError(undefined);
              setEnrolling(directory);
            } else {
              onComplete(directory);
            }
          },
          (cause: unknown) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
        );
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  if (enrolling) {
    return (
      <PickerFrame
        title="Cloud enrollment"
        keys={
          enrollmentSubmitting
            ? []
            : [
                { key: 'enter', label: 'Enroll' },
                { key: 'esc', label: 'Back' },
              ]
        }
      >
        <Text dimColor>
          Connect this Klex Bot to the cloud so it can be reached remotely.
        </Text>
        <Box marginTop={1} flexDirection="column">
          {enrollmentSubmitting ? (
            <Text>
              <Spinner type="dots" /> Enrolling...
            </Text>
          ) : (
            <>
              <Text>Paste your enrollment token below:</Text>
              <Box marginTop={1}>
                <Text>
                  Token:{' '}
                  <TextInput
                    value={enrollmentToken}
                    onChange={setEnrollmentToken}
                    placeholder="Paste enrollment token..."
                    onSubmit={() => {
                      if (!enrollCloud || enrollmentToken.trim().length === 0) {
                        setError('Enter an enrollment token to continue.');
                        return;
                      }
                      setError(undefined);
                      setEnrollmentSubmitting(true);
                      void enrollCloud(enrolling, enrollmentToken.trim()).then(
                        () => onComplete(enrolling),
                        (cause: unknown) => {
                          setEnrollmentSubmitting(false);
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : String(cause),
                          );
                        },
                      );
                    }}
                    showCursor
                  />
                </Text>
              </Box>
            </>
          )}
        </Box>
        <Box height={1}>{error ? <PickerError message={error} /> : null}</Box>
      </PickerFrame>
    );
  }

  if (creating) {
    return (
      <PickerFrame
        title="Create a new Klex Bot"
        keys={[
          { key: 'enter', label: 'Create' },
          { key: 'esc', label: 'Back' },
        ]}
      >
        <Text dimColor>
          Choose a name for this bot. It will be used as its local identity.
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Agent name:</Text>
          <TextInput
            value={name}
            onChange={setName}
            onSubmit={() => {
              void agentDirectory.create(name).then(
                (agent) => selectDirectory(agent.directory),
                (cause: unknown) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
              );
            }}
          />
        </Box>
        <Box height={1}>{error ? <PickerError message={error} /> : null}</Box>
      </PickerFrame>
    );
  }

  const items: MenuItem<string>[] = agents.map((agent) => ({
    label: agent.inUse
      ? `${agent.officialName} (${agent.directory}) — already started`
      : agent.compatibilityError
        ? `${agent.officialName} — ${agent.compatibilityError}`
        : agent.officialName,
    value: agent.directory,
    disabled: agent.inUse || Boolean(agent.compatibilityError),
  }));

  return (
    <PickerFrame
      title="Select a Klex Bot"
      keys={[
        ...(agents.length > 0
          ? [
              { key: '↑↓', label: 'Navigate' },
              { key: 'enter', label: 'Select' },
            ]
          : []),
        { key: 'a', label: 'Create a new Klex Bot' },
        { key: 'q', label: 'Quit' },
      ]}
    >
      <Text dimColor wrap="truncate-end">
        Started or incompatible bots cannot be selected.
      </Text>
      {items.length > 0 ? (
        <AgentChoiceList
          items={items}
          onSelect={(item) => selectDirectory(item.value)}
        />
      ) : (
        <Box marginTop={1}>
          <EmptyState>No Klex Bots found. Press [a] to create one.</EmptyState>
        </Box>
      )}
      <Box height={1}>{error ? <PickerError message={error} /> : null}</Box>
    </PickerFrame>
  );
}

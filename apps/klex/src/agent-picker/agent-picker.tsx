import { Box, render, Text, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { type ComponentProps, useEffect, useState } from 'react';

import type { AgentDirectory, DiscoveredAgent } from '@/agent-directory';
import { isDirectoryInUse } from '@/directory-lock';

export interface AgentPicker {
  choose(): Promise<string | undefined>;
}

interface Choice {
  label: string;
  value: string;
  disabled?: boolean;
}

function GroupedChoiceList({
  items,
  onSelect,
}: {
  items: Choice[];
  onSelect: (item: Choice) => void;
}) {
  const selectableItems = items.filter((item) => !item.disabled);
  const [selectedValue, setSelectedValue] = useState(selectableItems[0]?.value);

  useInput((input, key) => {
    const selectedIndex = Math.max(
      0,
      selectableItems.findIndex((item) => item.value === selectedValue),
    );

    if (input === 'k' || key.upArrow) {
      const previousIndex =
        (selectedIndex - 1 + selectableItems.length) % selectableItems.length;
      setSelectedValue(selectableItems[previousIndex]?.value);
    } else if (input === 'j' || key.downArrow) {
      const nextIndex = (selectedIndex + 1) % selectableItems.length;
      setSelectedValue(selectableItems[nextIndex]?.value);
    } else if (key.return) {
      const selectedItem = selectableItems[selectedIndex];
      if (selectedItem) onSelect(selectedItem);
    } else if (/^[1-9]$/.test(input)) {
      const selectedItem = selectableItems[Number.parseInt(input, 10) - 1];
      if (selectedItem) onSelect(selectedItem);
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item) => {
        const isAction = item.value === '__create__';
        const isSelected = item.value === selectedValue;
        return (
          <Box key={item.value} flexDirection="column">
            {isAction ? (
              <Box marginTop={1} marginBottom={0}>
                <Text dimColor>Actions</Text>
              </Box>
            ) : null}
            <Box>
              <Box width={2}>
                <Text color={isSelected ? 'blue' : undefined}>
                  {isSelected ? '›' : ' '}
                </Text>
              </Box>
              <Text
                color={isSelected ? 'blue' : undefined}
                dimColor={item.disabled}
              >
                {item.label}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export function createAgentPicker(deps: {
  agentDirectory: AgentDirectory;
  prepareCloud?: (directory: string) => Promise<boolean>;
  enrollCloud?: (directory: string, token: string) => Promise<void>;
}): AgentPicker {
  return {
    choose: () => chooseAgent(deps),
  };
}

async function chooseAgent(deps: {
  agentDirectory: AgentDirectory;
  prepareCloud?: (directory: string) => Promise<boolean>;
  enrollCloud?: (directory: string, token: string) => Promise<void>;
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
        prepareCloud={deps.prepareCloud}
        enrollCloud={deps.enrollCloud}
      />,
      { exitOnCtrlC: false },
    );
  });
}

function PickerSurface(props: ComponentProps<typeof PickerScreen>) {
  const { stdout } = useStdout();
  return (
    <Box
      flexDirection="column"
      justifyContent="center"
      height={stdout.rows || 24}
      width={stdout.columns || 80}
    >
      <PickerScreen {...props} />
    </Box>
  );
}

function PickerScreen({
  agents,
  onComplete,
  agentDirectory,
  prepareCloud,
  enrollCloud,
}: {
  agents: DiscoveredAgent[];
  onComplete: (directory: string | undefined) => void;
  agentDirectory: AgentDirectory;
  prepareCloud?: (directory: string) => Promise<boolean>;
  enrollCloud?: (directory: string, token: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [enrolling, setEnrolling] = useState<string | undefined>();
  const [enrollmentToken, setEnrollmentToken] = useState('');
  const [enrollmentSubmitting, setEnrollmentSubmitting] = useState(false);

  useInput((input, key) => {
    if (key.escape) {
      if (enrolling) setEnrolling(undefined);
      else if (creating) setCreating(false);
      else onComplete(undefined);
    } else if (input.toLowerCase() === 'q' && !creating && !enrolling) {
      onComplete(undefined);
    }
  });

  useEffect(() => {
    if (!creating) return;
    // TextInput owns Enter handling; this effect only keeps the screen state
    // deterministic when switching back from a failed creation attempt.
    setError(undefined);
  }, [creating]);

  const selectDirectory = (directory: string) => {
    void isDirectoryInUse(directory).then((inUse) => {
      if (inUse) {
        setError('This agent is already started. Choose another agent.');
        return;
      }
      if (!prepareCloud) {
        onComplete(directory);
        return;
      }
      void prepareCloud(directory).then(
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
    });
  };

  if (enrolling) {
    return (
      <Box flexDirection="column">
        <Text bold color="blue">
          Cloud enrollment
        </Text>
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
              <Text dimColor>
                Press Enter to enroll, or Escape to return to the bot list.
              </Text>
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
        {error ? <Text color="red">{error}</Text> : null}
      </Box>
    );
  }

  if (creating) {
    return (
      <Box flexDirection="column">
        <Text bold color="blue">
          Create a new Klex Bot
        </Text>
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
        {error ? <Text color="red">{error}</Text> : null}
        <Text dimColor>Press Escape to return.</Text>
      </Box>
    );
  }

  const items: Choice[] = [
    ...agents.map((agent) => ({
      label: agent.inUse
        ? `${agent.officialName} (${agent.directory}) — already started`
        : agent.officialName,
      value: agent.directory,
      disabled: agent.inUse,
    })),
    { label: 'Create a new Klex Bot', value: '__create__' },
    { label: 'Quit', value: '__quit__' },
  ];

  return (
    <Box flexDirection="column">
      <Text bold color="blue">
        Select a Klex Bot
      </Text>
      <Text dimColor>
        Choose an existing bot, or create a new one. Started bots are
        unavailable.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {error ? <Text color="red">{error}</Text> : null}
        <GroupedChoiceList
          items={items}
          onSelect={(item) => {
            if (item.value === '__create__') {
              setName('');
              setCreating(true);
            } else if (item.value === '__quit__') {
              onComplete(undefined);
            } else {
              selectDirectory(item.value);
            }
          }}
        />
      </Box>
    </Box>
  );
}

import { Box, type DOMElement, Text, useBoxMetrics, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';

import { type AdminApiClient, AdminApiClientError } from '../api-client';
import { ActivityIndicator } from '../components/activity-indicator';
import { ConfirmationPanel } from '../components/confirmation-panel';
import { KeyHint } from '../components/key-hint';
import { MultilineInput } from '../components/multiline-input';
import { ScreenSection } from '../components/screen-section';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTerminalSize } from '../hooks/use-terminal-size';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

type Operation = 'create' | 'update' | 'recreate';
type Mode = 'view' | 'edit' | 'confirm' | 'saving';
const LABELS: Record<Operation, string> = {
  create: 'Create soul',
  update: 'Update soul',
  recreate: 'Re-create soul',
};

export function SoulScreen({
  apiClient,
  onBack,
}: {
  apiClient: AdminApiClient;
  onBack: () => void;
}) {
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const { pushToast } = useToast();
  const { height } = useTerminalSize();
  const [soul, setSoul] = useState<string | null>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<Mode>('view');
  const [operation, setOperation] = useState<Operation>('create');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const contentRef = useRef<DOMElement>(null);
  const { height: contentHeight } = useBoxMetrics(contentRef);
  const visibleLines = Math.max(3, height - 18);
  const maxOffset = Math.max(0, contentHeight - visibleLines);
  const scrollOffset = Math.min(offset, maxOffset);
  const ready = !loading && !loadError && soul !== undefined;

  // revision is a manual refresh trigger, not request input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh must rerun the read
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void apiClient
      .getSoul(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setSoul(value);
        setLoading(false);
        setOffset(0);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(
          err instanceof AdminApiClientError
            ? err.message
            : 'Failed to load soul. Press r to retry.',
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [apiClient, revision]);

  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    setActive(mode === 'edit');
    return () => setActive(false);
  }, [mode, setActive]);
  useEffect(() => {
    setMeta({
      title: mode === 'view' ? 'Soul' : LABELS[operation],
      breadcrumb: ['Home', 'Settings'],
      keys:
        mode === 'saving'
          ? [{ key: 'esc', label: 'Cancel request' }]
          : mode === 'confirm'
            ? [
                { key: 'y', label: 'Re-create' },
                { key: 'n/esc', label: 'Keep editing' },
              ]
            : mode === 'edit'
              ? [
                  {
                    key: 'enter',
                    label:
                      operation === 'recreate' ? 'Continue' : 'Generate & save',
                  },
                  { key: 'shift+enter', label: 'New line' },
                  { key: 'esc', label: 'Keep draft' },
                ]
              : [
                  ...(ready
                    ? soul === null
                      ? [{ key: 'c', label: 'Create' }]
                      : [
                          { key: 'u', label: 'Update' },
                          { key: 'r', label: 'Re-create' },
                          { key: '↑↓', label: 'Scroll' },
                        ]
                    : []),
                  {
                    key: loadError ? 'r' : 'f',
                    label: loadError ? 'Retry' : 'Refresh',
                  },
                  { key: 'esc', label: 'Back' },
                ],
    });
  }, [setMeta, mode, operation, ready, soul, loadError]);

  function begin(next: Operation) {
    if (!ready || mode !== 'view') return;
    if (next !== operation) setInstructions('');
    setOperation(next);
    setError(null);
    setMode('edit');
  }

  async function generate(draft = instructions) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setMode('saving');
    setError(null);
    try {
      const result =
        operation === 'update'
          ? await apiClient.updateSoul(draft.trim(), controller.signal)
          : await apiClient.createSoul(draft.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setSoul(result);
      setOffset(0);
      setInstructions('');
      setMode('view');
      pushToast(
        operation === 'create'
          ? 'Soul created'
          : operation === 'update'
            ? 'Soul updated'
            : 'Soul re-created',
        'info',
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof AdminApiClientError
          ? err.message
          : 'Soul generation failed. Check your chat models and try again.',
      );
      setMode('edit');
      // Reconcile conflicts with cloud/tool writers without losing instructions.
      setRevision((value) => value + 1);
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'confirm') return; // The confirmation owns its Escape handler.
      if (mode === 'saving') {
        pending.current?.abort();
        pending.current = null;
        setMode('edit');
        setRevision((value) => value + 1);
      } else if (mode === 'edit') setMode('view');
      else onBack();
    },
    c: () => {
      if (soul === null) begin('create');
    },
    u: () => {
      if (soul) begin('update');
    },
    r: () => {
      if (mode !== 'view') return;
      if (loadError) setRevision((value) => value + 1);
      else if (soul) begin('recreate');
    },
    f: () => {
      if (mode === 'view' && !loading) setRevision((value) => value + 1);
    },
  });
  useInput((_, key) => {
    if (mode !== 'view') return;
    if (key.upArrow)
      setOffset((value) => Math.max(0, Math.min(value, maxOffset) - 1));
    if (key.downArrow) setOffset((value) => Math.min(maxOffset, value + 1));
    if (key.pageUp)
      setOffset((value) =>
        Math.max(0, Math.min(value, maxOffset) - visibleLines),
      );
    if (key.pageDown)
      setOffset((value) => Math.min(maxOffset, value + visibleLines));
  });

  if (mode === 'confirm') {
    return (
      <ConfirmationPanel
        title="Re-create soul?"
        onConfirm={generate}
        onCancel={() => setMode('edit')}
      >
        Generate a new identity from scratch, without including the current
        soul. The current soul stays in place until generation and saving
        succeed.
      </ConfirmationPanel>
    );
  }
  if (mode === 'saving') {
    return (
      <ScreenSection title={LABELS[operation]}>
        <ActivityIndicator label="Generating with your chat models..." />
        <Text dimColor>
          Up to 3 attempts, 60 seconds each. The saved soul stays in place until
          success.
        </Text>
        <Text dimColor>Press Esc to cancel the request.</Text>
      </ScreenSection>
    );
  }
  if (mode === 'edit') {
    return (
      <ScreenSection title={LABELS[operation]}>
        <Text dimColor>
          {operation === 'update'
            ? 'Describe what should change, or leave empty to refine the current soul. The model saves a full replacement.'
            : 'Describe personality, purpose, voice, and priorities. The model generates a complete soul from scratch.'}
        </Text>
        <Box marginTop={1}>
          <Text bold>
            {operation === 'update'
              ? 'Instructions (optional, up to 10,000 characters)'
              : 'Instructions (1–10,000 characters)'}
          </Text>
        </Box>
        <Box>
          <MultilineInput
            height={Math.max(2, Math.min(6, height - 16))}
            value={instructions}
            onChange={setInstructions}
            placeholder="e.g. Be direct, curious, and concise."
            onSubmit={(value) => {
              if (!ready) {
                setError(
                  'Refresh the saved soul before generating. Press Esc to return.',
                );
                return;
              }
              if (operation === 'update' && soul === null) {
                setError(
                  'The soul no longer exists. Press Esc, then c to create one.',
                );
                return;
              }
              if (
                (operation !== 'update' && !value.trim()) ||
                value.trim().length > 10_000
              ) {
                setError(
                  operation === 'update'
                    ? 'Instructions must contain at most 10,000 characters.'
                    : 'Instructions must contain 1–10,000 characters.',
                );
                return;
              }
              if (operation === 'recreate') setMode('confirm');
              else void generate(value);
            }}
          />
        </Box>
        {error ? <Text color="red">{error}</Text> : null}
        <Text dimColor>
          Generation uses your configured chat models. Successful output is
          saved immediately.
        </Text>
      </ScreenSection>
    );
  }
  return (
    <ScreenSection title="Soul">
      <Text dimColor>Personality, voice, purpose, and priorities.</Text>
      {loading ? <ActivityIndicator label="Loading soul..." /> : null}
      {loadError ? <Text color="red">{loadError}</Text> : null}
      {ready && soul === null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            No soul configured. Regular sessions are paused until one is saved.
          </Text>
          <Text>
            Press <KeyHint keyName="c" /> to create a soul from instructions.
          </Text>
        </Box>
      ) : null}
      {soul ? (
        <>
          <Box
            flexDirection="column"
            height={visibleLines}
            overflow="hidden"
            marginY={1}
          >
            <Box
              ref={contentRef}
              alignSelf="flex-start"
              flexDirection="column"
              flexShrink={0}
              width="100%"
              position="relative"
              top={-scrollOffset}
            >
              <Text wrap="hard">{soul}</Text>
            </Box>
          </Box>
          <Text dimColor>
            {soul.length.toLocaleString()} characters · {scrollOffset + 1}–
            {Math.min(contentHeight, scrollOffset + visibleLines)} of{' '}
            {contentHeight} lines
          </Text>
          <Text>
            <KeyHint keyName="u" /> Update existing soul ·{' '}
            <KeyHint keyName="r" /> Re-create from scratch
          </Text>
        </>
      ) : null}
    </ScreenSection>
  );
}

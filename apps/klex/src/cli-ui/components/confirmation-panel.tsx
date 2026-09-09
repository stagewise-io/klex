import { Box, Text } from 'ink';
import { type ReactNode, useRef } from 'react';

import { MenuKeys, useMenuInput } from '../menu-keys';
import { KeyHint } from './key-hint';
import { ScreenSection } from './screen-section';

export interface ConfirmationPanelProps {
  title: string;
  children: ReactNode;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmationPanel({
  title,
  children,
  onConfirm,
  onCancel,
}: ConfirmationPanelProps) {
  const confirming = useRef(false);
  const confirm = async () => {
    if (confirming.current) return;
    confirming.current = true;
    try {
      await onConfirm();
    } finally {
      confirming.current = false;
    }
  };

  useMenuInput({
    y: () => void confirm(),
    n: onCancel,
    [MenuKeys.Back]: onCancel,
  });

  return (
    <ScreenSection title={title} tone="red">
      <Text>{children}</Text>
      <Box marginTop={1}>
        <Text>
          Press <KeyHint keyName="y" color="red" /> to confirm or{' '}
          <KeyHint keyName="n" /> / <KeyHint keyName="esc" /> to cancel.
        </Text>
      </Box>
    </ScreenSection>
  );
}

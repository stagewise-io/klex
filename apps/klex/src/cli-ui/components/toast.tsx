import { Box, Text, useInput } from 'ink';
import { useEffect } from 'react';

import { useTextInputActive } from '../hooks/use-text-input-active';
import type { Toast as ToastType } from '../hooks/use-toast';

export interface ToastStackProps {
  toasts: ToastType[];
  onDismiss: (id: number) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  const latest = toasts.at(-1);
  const { active: textInputActive } = useTextInputActive();

  useInput((input) => {
    if (input.toLowerCase() === 'x' && latest && !textInputActive) {
      onDismiss(latest.id);
    }
  });

  if (!latest) return null;

  return (
    <Box flexDirection="column" alignItems="flex-end" paddingX={1}>
      <ToastItem toast={latest} onDismiss={onDismiss} />
      {toasts.length > 1 ? (
        <Text dimColor>{toasts.length - 1} more notification(s)</Text>
      ) : null}
    </Box>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastType;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 8000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const color =
    toast.level === 'error'
      ? 'red'
      : toast.level === 'warning'
        ? 'yellow'
        : 'blue';
  const label =
    toast.level === 'error'
      ? 'Error'
      : toast.level === 'warning'
        ? 'Warning'
        : 'Notice';

  return (
    <Box borderStyle="single" borderColor={color} paddingX={1}>
      <Text bold color={color}>
        {label}:{' '}
      </Text>
      <Text>{toast.message}</Text>
      <Text dimColor> [x] Dismiss</Text>
    </Box>
  );
}

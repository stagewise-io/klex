import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import type { Toast as ToastType } from '../hooks/use-toast';

export interface ToastStackProps {
  toasts: ToastType[];
  onDismiss: (id: number) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
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
  const [visible, setVisible] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss(toast.id);
    }, 8000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  useInput((_input, _key) => {
    if (!dismissed) {
      setDismissed(true);
      setVisible(false);
      onDismiss(toast.id);
    }
  });

  if (!visible) return null;

  const color =
    toast.level === 'error'
      ? 'red'
      : toast.level === 'warning'
        ? 'yellow'
        : 'blue';

  const label =
    toast.level === 'error'
      ? 'ERROR'
      : toast.level === 'warning'
        ? 'WARN'
        : 'INFO';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color} bold>
          [{label}]
        </Text>
        <Text> </Text>
        <Text color={color}>{toast.message}</Text>
      </Box>
      <Text dimColor>Press any key or wait 8s to dismiss</Text>
    </Box>
  );
}

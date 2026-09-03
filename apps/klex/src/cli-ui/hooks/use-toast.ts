import { createContext, type ReactNode, useContext } from 'react';

export interface Toast {
  id: number;
  message: string;
  level: 'error' | 'warning' | 'info';
}

export interface ToastContextValue {
  toasts: Toast[];
  pushToast: (message: string, level?: Toast['level']) => void;
  dismissToast: (id: number) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

export function ToastProviderBoundary({ children }: { children: ReactNode }) {
  // This is just a type guard boundary for testing.
  // The actual provider is in the ToastProvider component.
  return children;
}

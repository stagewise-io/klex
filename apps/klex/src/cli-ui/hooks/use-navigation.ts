import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

import type { Screen } from '../types';

export interface NavigationContextValue {
  current: Screen;
  params: Record<string, string>;
  navigate: (screen: Screen, params?: Record<string, string>) => void;
  goBack: () => void;
  canGoBack: boolean;
}

export const NavigationContext = createContext<NavigationContextValue | null>(
  null,
);

export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  return ctx;
}

interface HistoryEntry {
  screen: Screen;
  params: Record<string, string>;
}

export function useNavigationState(): NavigationContextValue {
  const [history, setHistory] = useState<HistoryEntry[]>([
    { screen: 'home', params: {} },
  ]);

  const navigate = useCallback(
    (screen: Screen, params: Record<string, string> = {}) => {
      setHistory((h) => [...h, { screen, params }]);
    },
    [],
  );

  const goBack = useCallback(() => {
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
  }, []);

  const current = history[history.length - 1] ?? {
    screen: 'home' as Screen,
    params: {},
  };

  return useMemo(
    () => ({
      current: current.screen,
      params: current.params,
      navigate,
      goBack,
      canGoBack: history.length > 1,
    }),
    [current, navigate, goBack, history.length],
  );
}

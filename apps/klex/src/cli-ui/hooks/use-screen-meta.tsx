import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export interface ScreenMeta {
  title: string;
  breadcrumb: string[];
  keys: { key: string; label: string }[];
}

export interface ScreenMetaContextValue {
  meta: ScreenMeta;
  setMeta: (meta: ScreenMeta) => void;
}

const DEFAULT_META: ScreenMeta = {
  title: 'Home',
  breadcrumb: [],
  keys: [
    { key: 's', label: 'Settings' },
    { key: 'c', label: 'Cloud' },
    { key: 'r', label: 'Refresh' },
  ],
};

export const ScreenMetaContext = createContext<ScreenMetaContextValue | null>(
  null,
);

export function useScreenMeta(): ScreenMetaContextValue {
  const ctx = useContext(ScreenMetaContext);
  if (!ctx) {
    throw new Error('useScreenMeta must be used within a ScreenMetaProvider');
  }
  return ctx;
}

export function useSetScreenMeta(meta: ScreenMeta): void {
  const { setMeta } = useScreenMeta();
  useEffect(() => setMeta(meta), [meta, setMeta]);
}

export function ScreenMetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<ScreenMeta>(DEFAULT_META);

  const value = useMemo(() => ({ meta, setMeta }), [meta]);

  return (
    <ScreenMetaContext.Provider value={value}>
      {children}
    </ScreenMetaContext.Provider>
  );
}

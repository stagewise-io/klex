import { createContext, type ReactNode, useContext, useState } from 'react';

interface TextInputActiveValue {
  active: boolean;
  setActive: (active: boolean) => void;
}

const TextInputActiveContext = createContext<TextInputActiveValue>({
  active: false,
  setActive: () => {},
});

export function TextInputActiveProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  return (
    <TextInputActiveContext.Provider value={{ active, setActive }}>
      {children}
    </TextInputActiveContext.Provider>
  );
}

export function useTextInputActive(): TextInputActiveValue {
  return useContext(TextInputActiveContext);
}

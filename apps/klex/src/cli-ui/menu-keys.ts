import { useInput } from 'ink';

import { useTextInputActive } from './hooks/use-text-input-active';

export const MenuKeys = {
  Settings: 's',
  Cloud: 'c',
  Usage: 'u',
  Refresh: 'r',
  Quit: 'q',
  Back: 'escape',
  Delete: 'd',
  Add: 'a',
  Edit: 'e',
  Enter: 'return',
} as const;

export type MenuKeyAction = Partial<Record<string, () => void>>;

export function useMenuInput(actions: MenuKeyAction) {
  const { active } = useTextInputActive();

  useInput((input, key) => {
    // Text fields own character input. Keep Escape available so every form
    // can still be cancelled without triggering unrelated shortcuts.
    if (key.escape && actions.escape) {
      actions.escape();
      return;
    }
    if (key.return && actions.return) {
      actions.return();
      return;
    }
    if (key.backspace && actions.backspace) {
      actions.backspace();
      return;
    }
    if (key.delete && actions.delete) {
      actions.delete();
      return;
    }
    if (active) return;

    const lower = input.toLowerCase();
    if (actions[lower]) {
      actions[lower]();
    }
  });
}

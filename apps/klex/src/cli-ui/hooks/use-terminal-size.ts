import { useStdout } from 'ink';

export const DEFAULT_TERMINAL_WIDTH = 80;
export const DEFAULT_TERMINAL_HEIGHT = 24;

export function terminalSize(stdout: { columns?: number; rows?: number }): {
  width: number;
  height: number;
} {
  return {
    width: stdout.columns || DEFAULT_TERMINAL_WIDTH,
    height: stdout.rows || DEFAULT_TERMINAL_HEIGHT,
  };
}

export function useTerminalSize(): { width: number; height: number } {
  const { stdout } = useStdout();
  return terminalSize(stdout);
}

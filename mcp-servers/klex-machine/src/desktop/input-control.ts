export const DESKTOP_INPUT_ACTIONS = [
  'click',
  'drag',
  'move',
  'scroll',
  'type',
  'key',
  'focusWindow',
  'launch',
] as const;

export type DesktopInputAction = (typeof DESKTOP_INPUT_ACTIONS)[number];

export interface DesktopInputRequest {
  action: DesktopInputAction;
  principalId: string;
}

/**
 * Decides whether the agent may send input to the desktop. Observation
 * (screenshots, window lists) is never gated. A human takeover lease plugs in
 * here and rejects with {@link DesktopInputDeniedError}.
 */
export interface DesktopInputControl {
  authorize(request: DesktopInputRequest): void | Promise<void>;
}

export class DesktopInputDeniedError extends Error {
  readonly code: string;
  readonly holder?: string;

  constructor(
    message: string,
    options: { code?: string; holder?: string } = {},
  ) {
    super(message);
    this.name = 'DesktopInputDeniedError';
    this.code = options.code ?? 'desktop_controlled_by_user';
    if (options.holder !== undefined) this.holder = options.holder;
  }
}

export const allowAgentDesktopInput: DesktopInputControl = {
  authorize: () => undefined,
};

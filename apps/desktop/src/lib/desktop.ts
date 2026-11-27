import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Mirrors `AppStatus` in src-tauri/src/status.rs. */
export type ConnectionState = 'connecting' | 'connected' | 'offline' | 'error';

export interface DesktopStatus {
  paired: boolean;
  /** Whether the person wants this computer connected. */
  enabled: boolean;
  /** `stopped` while disconnected or not paired. */
  state: ConnectionState | 'stopped';
  machineId: string | null;
  organizationName: string | null;
  reason: string | null;
  autostart: boolean;
  /** A downloaded update waiting for "Restart to update". */
  updateVersion: string | null;
}

export interface EnrollmentPreview {
  organizationName: string;
  machineName: string;
  expiresAt: string;
}

/** Mirrors `PairingError` in src-tauri/src/pairing.rs. */
export type PairingError =
  | { kind: 'invalidCode' }
  | { kind: 'rateLimited' }
  | { kind: 'alreadyPaired' }
  | { kind: 'noPendingCode' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'failed'; message: string };

export interface LogLine {
  time: string;
  source: 'app' | 'daemon';
  message: string;
}

export function isPairingError(value: unknown): value is PairingError {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

export const desktop = {
  status: () => invoke<DesktopStatus>('status'),
  previewCode: (code: string) =>
    invoke<EnrollmentPreview>('preview_code', { code }),
  confirmPairing: () => invoke<DesktopStatus>('confirm_pairing'),
  cancelPairing: () => invoke<void>('cancel_pairing'),
  takePendingPairCode: () => invoke<string | null>('take_pending_pair_code'),
  setEnabled: (enabled: boolean) =>
    invoke<DesktopStatus>('set_enabled', { enabled }),
  forget: () => invoke<DesktopStatus>('forget'),
  setAutostart: (enabled: boolean) =>
    invoke<DesktopStatus>('set_autostart', { enabled }),
  logs: () => invoke<LogLine[]>('logs'),
  openLogFolder: () => invoke<void>('open_log_folder'),
  installUpdate: () => invoke<void>('install_update'),
};

export function onStatus(handler: (status: DesktopStatus) => void) {
  return listen<DesktopStatus>('status', (event) => handler(event.payload));
}

export function onLog(handler: (line: LogLine) => void) {
  return listen<LogLine>('log', (event) => handler(event.payload));
}

export function onPairCode(handler: (code: string) => void) {
  return listen<string>('pair-code', (event) => handler(event.payload));
}

/** Subscribes in an effect and unsubscribes even if cleanup runs first. */
export function subscribe(registration: Promise<UnlistenFn>): () => void {
  let unlisten: UnlistenFn | undefined;
  let disposed = false;
  void registration.then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

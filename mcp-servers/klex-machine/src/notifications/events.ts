import type {
  JSONValue,
  PushNotification,
} from '@stagewise/mcp-extension-push-notifications';

export const NOTIFICATION_SOURCE_ID = 'klex-machine';
export const OUTPUT_TAIL_CHARACTERS = 4096;

export type WatcherOutcome = 'condition_met' | 'failed' | 'timed_out';

export interface WatcherEventInfo {
  watcherId: string;
  title: string;
  command: string;
  cwd: string;
  createdAt: string;
}

export interface WatcherCompletion {
  outcome: WatcherOutcome;
  exitCode: number | null;
  signal: string | null;
  finishedAt: string;
  output: string;
}

export interface ShellEventInfo {
  sessionId: string;
  shell: string;
  cwd: string;
  createdAt: string;
}

export interface ShellExit {
  exitCode: number | null;
  signal: number | null;
  exitedAt: string;
  output: string;
}

const ANSI_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the purpose.
  /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|\u009c/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function tail(
  text: string,
  maxCharacters = OUTPUT_TAIL_CHARACTERS,
): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) return { text, truncated: false };
  return { text: text.slice(text.length - maxCharacters), truncated: true };
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join('');
}

function withOutput(summary: string, output: string): string {
  return output.length > 0 ? `${summary}\n\nLast output:\n${output}` : summary;
}

function notification(
  eventId: string,
  type: string,
  createdAt: string,
  text: string,
  data: { [key: string]: JSONValue },
): PushNotification {
  return {
    eventId,
    sourceId: NOTIFICATION_SOURCE_ID,
    type,
    createdAt,
    content: [{ type: 'text', text }],
    data,
  };
}

export function watcherCompletedEvent(
  info: WatcherEventInfo,
  completion: WatcherCompletion,
): PushNotification {
  const output = tail(stripAnsi(completion.output));
  const duration = formatDuration(
    Date.parse(completion.finishedAt) - Date.parse(info.createdAt),
  );
  const status =
    completion.outcome === 'condition_met'
      ? 'condition met'
      : completion.outcome === 'timed_out'
        ? 'timed out'
        : `failed (${
            completion.signal !== null
              ? `signal ${completion.signal}`
              : `exit ${completion.exitCode ?? 'unknown'}`
          })`;
  return notification(
    `watcher:${info.watcherId}:completed`,
    'watcher.completed',
    completion.finishedAt,
    withOutput(
      `Watcher "${info.title}" ${status} after ${duration}.`,
      output.text,
    ),
    {
      watcherId: info.watcherId,
      title: info.title,
      command: info.command,
      cwd: info.cwd,
      outcome: completion.outcome,
      exitCode: completion.exitCode,
      signal: completion.signal,
      createdAt: info.createdAt,
      finishedAt: completion.finishedAt,
      outputTail: output.text,
      outputTruncated: output.truncated,
    },
  );
}

export function watcherLostEvent(
  info: WatcherEventInfo,
  lostAt: string,
): PushNotification {
  return notification(
    `watcher:${info.watcherId}:lost`,
    'watcher.lost',
    lostAt,
    `Watcher "${info.title}" was lost because klex-machine restarted; it will not fire. Recreate it if still needed.`,
    {
      watcherId: info.watcherId,
      title: info.title,
      command: info.command,
      cwd: info.cwd,
      createdAt: info.createdAt,
      lostAt,
    },
  );
}

export function shellExitedEvent(
  info: ShellEventInfo,
  exit: ShellExit,
): PushNotification {
  const output = tail(stripAnsi(exit.output));
  const status =
    exit.signal !== null && exit.signal !== 0
      ? `signal ${exit.signal}`
      : `code ${exit.exitCode ?? 'unknown'}`;
  return notification(
    `shell:${info.sessionId}:exited`,
    'shell.exited',
    exit.exitedAt,
    withOutput(
      `Shell session ${info.sessionId} exited (${status}).`,
      output.text,
    ),
    {
      sessionId: info.sessionId,
      shell: info.shell,
      cwd: info.cwd,
      exitCode: exit.exitCode,
      signal: exit.signal,
      createdAt: info.createdAt,
      exitedAt: exit.exitedAt,
      outputTail: output.text,
      outputTruncated: output.truncated,
    },
  );
}

export function shellLostEvent(
  info: ShellEventInfo,
  lostAt: string,
): PushNotification {
  return notification(
    `shell:${info.sessionId}:lost`,
    'shell.lost',
    lostAt,
    `Shell session ${info.sessionId} was lost because klex-machine restarted.`,
    {
      sessionId: info.sessionId,
      shell: info.shell,
      cwd: info.cwd,
      createdAt: info.createdAt,
      lostAt,
    },
  );
}

import { escapeXml } from '../history-xml';

export const DEEP_THINKER_REPORT_KEY = 'deep-thinker-report';
export const DEEP_THINKERS_KEY = 'deep-thinkers';

export type DeepThinkReportData = {
  handle: string;
  content: string;
  final?: boolean;
};

export type DeepThinkSession = {
  childSessionId: string;
  handle: string;
  reportCount: number;
  startedAt: string;
  status: 'running' | 'finished';
};

export type DeepThinkSessionContextData =
  | { mode: 'full'; sessions: DeepThinkSession[] }
  | { mode: 'change'; sessions: DeepThinkSession[]; changes: string[] };

export function contextPrompt(serializedHistory: string): string {
  return `<main-session-context>\n${serializedHistory}\n</main-session-context>`;
}

export function updatePrompt(content: string): string {
  return `<message-from-main>\n${escapeXml(content)}\n</message-from-main>`;
}

export function reportPrompt(data: DeepThinkReportData): string {
  const final = data.final ? ' final' : '';
  return `<${DEEP_THINKER_REPORT_KEY} handle=${escapeXml(data.handle)}${final}>\n${escapeXml(data.content)}\n</${DEEP_THINKER_REPORT_KEY}>`;
}

function fullPrompt(sessions: DeepThinkSession[]): string {
  const rows = sessions.map(
    (session) => `${session.handle}: ${session.status}`,
  );
  return [
    `<${DEEP_THINKERS_KEY} full>`,
    ...rows,
    `</${DEEP_THINKERS_KEY}>`,
  ].join('\n');
}

function changePrompt(changes: string[]): string {
  return [
    `<${DEEP_THINKERS_KEY} change>`,
    ...changes,
    `</${DEEP_THINKERS_KEY}>`,
  ].join('\n');
}

export function sessionsPrompt(data: DeepThinkSessionContextData): string {
  return data.mode === 'full'
    ? fullPrompt(data.sessions)
    : changePrompt(data.changes);
}

import { escapeXml } from '../history-xml';

export const CONSULT_REPORT_KEY = 'consult-report';
export const CONSULTS_KEY = 'consults';

export type ConsultReportData = {
  handle: string;
  content: string;
  final?: boolean;
};

export type ConsultSession = {
  childSessionId: string;
  handle: string;
  reportCount: number;
  startedAt: string;
  status: 'running' | 'finished';
};

export type ConsultSessionContextData =
  | { mode: 'full'; sessions: ConsultSession[] }
  | { mode: 'change'; sessions: ConsultSession[]; changes: string[] };

export function contextPrompt(serializedHistory: string): string {
  return `<main-session-context>\n${serializedHistory}\n</main-session-context>`;
}

export function updatePrompt(content: string): string {
  return `<message-from-main>\n${escapeXml(content)}\n</message-from-main>`;
}

export function reportPrompt(data: ConsultReportData): string {
  const final = data.final ? ' final' : '';
  return `<${CONSULT_REPORT_KEY} handle=${escapeXml(data.handle)}${final}>\n${escapeXml(data.content)}\n</${CONSULT_REPORT_KEY}>`;
}

function fullPrompt(sessions: ConsultSession[]): string {
  const rows = sessions.map(
    (session) => `${session.handle}: ${session.status}`,
  );
  return [`<${CONSULTS_KEY} full>`, ...rows, `</${CONSULTS_KEY}>`].join('\n');
}

function changePrompt(changes: string[]): string {
  return [`<${CONSULTS_KEY} change>`, ...changes, `</${CONSULTS_KEY}>`].join(
    '\n',
  );
}

export function sessionsPrompt(data: ConsultSessionContextData): string {
  return data.mode === 'full'
    ? fullPrompt(data.sessions)
    : changePrompt(data.changes);
}

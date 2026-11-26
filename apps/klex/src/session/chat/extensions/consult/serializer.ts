import {
  type DataBlock,
  field,
  renderDataBlock,
  tableField,
} from '@/session/chat/utils/history-view';

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
  return renderDataBlock({
    type: 'main-session-context',
    fields: [field('history', serializedHistory, 'bot')],
  });
}

export function updatePrompt(content: string): string {
  return renderDataBlock({
    type: 'message-from-main',
    fields: [field('content', content, 'bot')],
  });
}

export function reportBlock(data: ConsultReportData): DataBlock {
  return {
    type: CONSULT_REPORT_KEY,
    fields: [
      field('handle', data.handle, 'bot'),
      field('final', data.final ?? false, 'trusted'),
      field('content', data.content, 'bot'),
    ],
  };
}

function fullBlock(sessions: ConsultSession[]): DataBlock {
  return {
    type: CONSULTS_KEY,
    fields: [
      tableField(
        'sessions',
        ['handle', 'status'],
        sessions.map((session) => [session.handle, session.status]),
        'bot',
      ),
    ],
  };
}

function changeBlock(changes: string[]): DataBlock {
  return {
    type: 'consults-update',
    fields: [field('changes', changes, 'bot')],
  };
}

export function sessionsBlock(data: ConsultSessionContextData): DataBlock {
  return data.mode === 'full'
    ? fullBlock(data.sessions)
    : changeBlock(data.changes);
}

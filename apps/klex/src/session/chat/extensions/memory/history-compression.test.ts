import { describe, expect, it, vi } from 'vitest';

import {
  RECORD_SEPARATOR,
  renderFittedMessage,
} from '@/session/chat/utils/history-view';

import type { ExtendedUIMessage } from '../../message-types';
import { createDataPart } from '../extension-api';
import { episodeEntryText, toEpisodeRecordInputs } from './episodes';
import { collectEpisodicHistory } from './history-compression';

vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: 'Time.',
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    getToolName: (part: { type: string; toolName?: string }) =>
      part.toolName ?? part.type.replace(/^tool-/, ''),
    isToolUIPart: (part: { type: string }) =>
      part.type === 'tool' || part.type.startsWith('tool-'),
  };
});

function textMessage(
  role: 'user' | 'assistant',
  text: string,
  id: string,
): ExtendedUIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

function contextMessage(id: string): ExtendedUIMessage {
  return {
    id,
    role: 'user',
    parts: [
      {
        type: 'data-context',
        data: {
          sourceEnv: 'test',
          metadata: {},
          content: [
            { type: 'text', text: 'context' },
            { type: 'image', mimeType: 'image/png', data: 'binary' },
          ],
        },
      } as never,
    ],
  };
}

function toolMessage(id: string, toolName = 'doWork'): ExtendedUIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'dynamic-tool',
        toolCallId: `${id}-call`,
        toolName,
        input: {},
        output: 'ok',
        state: 'output-available',
      } as never,
    ],
  };
}

/** Line texts of the episode records collected after `cursor`. */
function collectTexts(history: ExtendedUIMessage[], cursor: string | null) {
  const result = collectEpisodicHistory(history, cursor);
  const texts = toEpisodeRecordInputs(result.messages).map((input) =>
    episodeEntryText({ kind: 'record', v: 1, at: '', ...input }),
  );
  return { texts, cursor: result.cursor };
}

describe('collectEpisodicHistory', () => {
  it('returns records and advances the cursor', () => {
    const history = [
      textMessage('user', 'ignored', 'u1'),
      textMessage('assistant', 'answer', 'a1'),
    ];
    expect(collectEpisodicHistory(history, null)).toEqual({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          records: [{ kind: 'text', text: 'answer' }],
          omittedRecords: 0,
        },
      ],
      cursor: 'a1',
    });
  });

  it('keeps omissions on the last record so entries reproduce the line text', () => {
    const longParts: ExtendedUIMessage = {
      id: 'many',
      role: 'assistant',
      parts: Array.from({ length: 20 }, (_, index) => ({
        type: 'text' as const,
        text: `${index}-${'x'.repeat(500)}`,
      })),
    };
    const [message] = collectEpisodicHistory([longParts], null).messages;
    expect(message?.omittedRecords).toBeGreaterThan(0);
    const inputs = toEpisodeRecordInputs([message!]);
    expect(inputs.slice(0, -1).some((input) => input.omittedRecords)).toBe(
      false,
    );
    expect(inputs.at(-1)?.omittedRecords).toBe(message?.omittedRecords);
    expect(collectTexts([longParts], null).texts.join(RECORD_SEPARATOR)).toBe(
      renderFittedMessage(message!).text,
    );
  });

  it('uses placeholders for media', () => {
    const [message] = collectEpisodicHistory(
      [contextMessage('ctx')],
      null,
    ).messages;
    expect(JSON.stringify(message)).not.toContain('binary');
    expect(collectTexts([contextMessage('ctx')], null).texts[0]).toContain(
      'image png',
    );
  });

  it('does not budget-truncate a large delta', () => {
    const history = Array.from({ length: 10 }, (_, index) =>
      textMessage('assistant', `${index}-${'x'.repeat(500)}`, `a${index}`),
    );
    const result = collectTexts(history, null);
    expect(result.texts).toHaveLength(10);
    expect(result.cursor).toBe('a9');
  });

  it('skips recall and user-facing memory results', () => {
    const result = collectTexts(
      [
        toolMessage('recall', 'recall'),
        textMessage('user', '<memory>secret</memory>', 'memory'),
      ],
      null,
    );
    expect(result).toEqual({ texts: [], cursor: 'memory' });
  });

  it('includes a time update', () => {
    const result = collectTexts(
      [
        {
          id: 'time',
          role: 'user',
          parts: [
            createDataPart('time', {
              timestamp: Date.parse('2026-09-18T14:05:00.000Z') / 1000,
              tz: 'Europe/Berlin',
            }) as never,
          ],
        },
      ],
      null,
    );
    expect(result.texts).toEqual(['time_update\n¦Friday, 18.9.2026, 16:05']);
  });
});

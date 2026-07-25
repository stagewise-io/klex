import type { TextPart } from 'ai';

import type {
  ExtendedUIMessage,
  HistorySummaryDataUIPart,
} from '@/session/types';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  PreProcessingResult,
} from '../extension-api';

class HistoryCompressionExt implements Extension {
  constructor(private readonly deps: ExtensionDeps) {}

  onHistoryPreProcessing(history: ExtendedUIMessage[]): PreProcessingResult {
    const lastSummaryIndex = history.findLastIndex((m) =>
      m.parts.some((p) => p.type === 'data-history-summary'),
    );

    if (lastSummaryIndex === -1) return history;

    return {
      history: history.slice(lastSummaryIndex),
      flags: { hasCompacted: true },
    };
  }

  dataPartTransformers = {
    'history-summary': (part: HistorySummaryDataUIPart): TextPart[] => [
      {
        type: 'text',
        text: `<summary>${part.summary}</summary>`,
      },
    ],
  };
}

export const createHistoryCompressionExt: ExtensionFactory = (deps) =>
  new HistoryCompressionExt(deps);

import type {
  ExtendedUIMessage,
  HistorySummaryDataUIPart,
} from '@/session/types';

export const compressHistory = async (
  _history: ExtendedUIMessage[],
): Promise<HistorySummaryDataUIPart> => {
  return {
    summary: 'Not implemented yet!',
  };
};

import type {
  ExtendedUIMessage,
  HistorySummaryDataUIPart,
} from '@/session/types';

export const compressHistory = async (
  history: ExtendedUIMessage[],
): Promise<HistorySummaryDataUIPart> => {
  return {
    summary: 'Not implemented yet!',
  };
};

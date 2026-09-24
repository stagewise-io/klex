import { applyBudget } from './budget';
import { renderLineMessage } from './lines';
import { applyScope, projectMessage } from './project';
import type {
  HistoryMessage,
  HistoryScope,
  HistoryView,
  HistoryViewOptions,
  RenderedHistory,
} from './types';

/**
 * Turns main-session history into a compact view for another model:
 * scope -> filter/projection -> line rendering -> aggregate budget.
 */
class HistoryViewModule implements HistoryView {
  constructor(private readonly options: HistoryViewOptions) {}

  render(
    history: readonly HistoryMessage[],
    scope: HistoryScope = { kind: 'all' },
  ): RenderedHistory {
    const { filter, lines, budget } = this.options;
    const { messages, startCursor } = applyScope(history, scope);
    const rendered = messages.map((message) => {
      const projected = projectMessage(message, filter);
      return {
        id: projected.id,
        hasSummary: projected.hasSummary,
        rendered:
          projected.records.length > 0
            ? renderLineMessage(projected, lines)
            : null,
      };
    });
    return applyBudget(rendered, startCursor, budget);
  }
}

export function createHistoryView(options: HistoryViewOptions): HistoryView {
  return new HistoryViewModule(options);
}

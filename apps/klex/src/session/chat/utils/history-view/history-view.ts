import { applyBudget } from './budget';
import { createDataPartDispatcher } from './data-parts';
import { fitLineMessage, renderFittedMessage } from './lines';
import { applyScope, projectMessage } from './project';
import type {
  FittedHistory,
  FittedMessage,
  HistoryMessage,
  HistoryScope,
  HistoryView,
  HistoryViewOptions,
  RenderedHistory,
} from './types';

/**
 * Turns main-session history into a compact view for another model:
 * scope -> filter/projection -> line limits -> line rendering -> aggregate
 * budget. `fit` stops after the line limits and returns structured records.
 */
class HistoryViewModule implements HistoryView {
  constructor(private readonly options: HistoryViewOptions) {}

  render(
    history: readonly HistoryMessage[],
    scope: HistoryScope = { kind: 'all' },
  ): RenderedHistory {
    const { messages, startCursor } = applyScope(history, scope);
    const dispatcher = this.dispatcher(history, messages);
    const rendered = messages.map((message) => {
      const { hasSummary, fitted } = this.fitMessage(message, dispatcher);
      return {
        id: message.id,
        hasSummary,
        rendered: fitted ? renderFittedMessage(fitted) : null,
      };
    });
    return applyBudget(rendered, startCursor, this.options.budget);
  }

  fit(
    history: readonly HistoryMessage[],
    scope: HistoryScope = { kind: 'all' },
  ): FittedHistory {
    const { messages, startCursor } = applyScope(history, scope);
    const dispatcher = this.dispatcher(history, messages);
    return {
      messages: messages.flatMap((message) => {
        const { fitted } = this.fitMessage(message, dispatcher);
        return fitted ? [fitted] : [];
      }),
      cursor: messages.at(-1)?.id ?? startCursor,
    };
  }

  private dispatcher(
    history: readonly HistoryMessage[],
    messages: readonly HistoryMessage[],
  ) {
    const dispatcher = createDataPartDispatcher(
      this.options.transformers ?? {},
    );
    const first = messages[0];
    const start = first ? history.indexOf(first) : history.length;
    for (const message of history.slice(0, start))
      for (const part of message.parts) dispatcher.consume(part);
    return dispatcher;
  }

  private fitMessage(
    message: HistoryMessage,
    dispatcher: ReturnType<typeof createDataPartDispatcher>,
  ): {
    hasSummary: boolean;
    fitted: FittedMessage | null;
  } {
    const projected = projectMessage(message, this.options.filter, dispatcher);
    return {
      hasSummary: projected.hasSummary,
      fitted:
        projected.records.length > 0
          ? fitLineMessage(projected, this.options.lines)
          : null,
    };
  }
}

export function createHistoryView(options: HistoryViewOptions): HistoryView {
  return new HistoryViewModule(options);
}

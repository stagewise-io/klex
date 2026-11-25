import type { ToolSet } from 'ai';

import type {
  Extension,
  StepCompleteEvent,
} from '@/session/chat/extensions/extension-api';
import type { ChildSessionHandle } from '@/session/types';

class ChildToolsExtension implements Extension {
  constructor(
    private readonly get: () => ToolSet,
    readonly onStepComplete: (event: StepCompleteEvent) => void,
  ) {}
  getTools(): ToolSet {
    return this.get();
  }
}

/**
 * Tools of a memory child session plus its completion signal. `onOutcome`
 * receives false on any failed step and true on a normal generation. The
 * no-generation decision step that ends a turn reports nothing, so success
 * survives that clean skip but never a later failure.
 */
export function childToolsExtension(
  get: () => ToolSet,
  onOutcome: (completed: boolean) => void,
): Extension {
  return new ChildToolsExtension(get, (event) => {
    if (
      event.forceNextStep ||
      event.generationFailed ||
      event.fatalError ||
      event.requestRejected ||
      event.modelFallbackOccurred ||
      event.instinctAborted
    )
      onOutcome(false);
    else if (event.generation) onOutcome(true);
  });
}

/**
 * Waits until the child's turn settles. Throws when the child terminates or
 * settles without a successful completion; returns early once closed.
 */
export async function settleChild(
  child: ChildSessionHandle,
  label: string,
  isClosed: () => boolean,
  completed: () => boolean,
): Promise<void> {
  while (!isClosed()) {
    if (child.getSessionInfo().status === 'terminated')
      throw new Error(`${label} session terminated`);
    if (await child.waitForIdle(1_000)) {
      if (child.getSessionInfo().status === 'terminated')
        throw new Error(`${label} terminated before settling`);
      if (!completed())
        throw new Error(`${label} did not complete successfully`);
      return;
    }
  }
}

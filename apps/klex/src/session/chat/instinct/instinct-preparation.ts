import type { InstinctPreparation } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';

type Parts = ExtendedUIMessage['parts'];

/** Operations one extension staged during its instinct reaction. */
interface StagedOperations {
  readonly persistent: Parts;
  readonly provisional: Parts;
  readonly ephemeral: Parts;
}

/**
 * Per-extension staging buffer behind {@link InstinctPreparation}. The runner
 * seals it once the reaction settles; only a buffer sealed as `kept` hands
 * its operations to the commit. Calls after sealing throw, so a reaction
 * that ignores its abort signal cannot leak changes into a later step.
 */
export class InstinctPreparationBuffer implements InstinctPreparation {
  private readonly persistent: Parts[number][] = [];
  private readonly provisional: Parts[number][] = [];
  private readonly ephemeral: Parts[number][] = [];
  private state: 'open' | 'kept' | 'dropped' = 'open';

  constructor(
    private readonly extensionIdentifier: string,
    private readonly ownedDataPartKeys: ReadonlySet<string>,
  ) {}

  appendPersistent(parts: Parts): void {
    this.assertOpen('appendPersistent');
    for (const part of parts) {
      if (
        !part.type.startsWith('data-') ||
        !this.ownedDataPartKeys.has(part.type.slice('data-'.length))
      ) {
        throw new Error(
          `Extension "${this.extensionIdentifier}" staged a persistent "${part.type}" part; persistent instinct content must use an extension-owned data-* part.`,
        );
      }
    }
    this.persistent.push(...structuredClone(parts));
  }

  appendProvisional(parts: Parts): void {
    this.assertOpen('appendProvisional');
    this.provisional.push(...structuredClone(parts));
  }

  appendEphemeral(parts: Parts): void {
    this.assertOpen('appendEphemeral');
    this.ephemeral.push(...structuredClone(parts));
  }

  /** Seals the buffer and keeps its operations for the commit. */
  keep(): void {
    if (this.state === 'open') this.state = 'kept';
  }

  /** Seals the buffer and discards its operations. */
  drop(): void {
    if (this.state === 'open') this.state = 'dropped';
  }

  /** Operations to commit; empty unless the buffer was sealed as kept. */
  operations(): StagedOperations {
    if (this.state !== 'kept') {
      return { persistent: [], provisional: [], ephemeral: [] };
    }
    return {
      persistent: [...this.persistent],
      provisional: [...this.provisional],
      ephemeral: [...this.ephemeral],
    };
  }

  /** Staged counts regardless of seal state, for observability. */
  counts(): { persistent: number; provisional: number; ephemeral: number } {
    return {
      persistent: this.persistent.length,
      provisional: this.provisional.length,
      ephemeral: this.ephemeral.length,
    };
  }

  private assertOpen(operation: string): void {
    if (this.state !== 'open') {
      throw new Error(
        `InstinctPreparation.${operation} called by "${this.extensionIdentifier}" after its instinct reaction settled.`,
      );
    }
  }
}

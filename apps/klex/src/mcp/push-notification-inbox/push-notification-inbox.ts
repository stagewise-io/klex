import type { PushNotification } from '@stagewise/mcp-extension-push-notifications';

export interface PushNotificationInbox {
  readCursor(namespace: string): Promise<string | undefined>;
  reset(namespace: string): Promise<void>;
  commit(
    namespace: string,
    events: readonly PushNotification[],
    nextCursor: string,
  ): Promise<PushNotification[]>;
}

class InMemoryPushNotificationInboxModule implements PushNotificationInbox {
  private readonly cursors = new Map<string, string>();
  private readonly eventIds = new Map<string, Set<string>>();

  async readCursor(namespace: string): Promise<string | undefined> {
    return this.cursors.get(namespace);
  }

  async reset(namespace: string): Promise<void> {
    this.cursors.delete(namespace);
    this.eventIds.delete(namespace);
  }

  async commit(
    namespace: string,
    events: readonly PushNotification[],
    nextCursor: string,
  ): Promise<PushNotification[]> {
    let known = this.eventIds.get(namespace);
    if (!known) {
      known = new Set();
      this.eventIds.set(namespace, known);
    }

    const accepted: PushNotification[] = [];
    for (const event of events) {
      if (known.has(event.eventId)) continue;
      known.add(event.eventId);
      accepted.push(structuredClone(event));
    }
    this.cursors.set(namespace, nextCursor);
    return accepted.map((event) => structuredClone(event));
  }
}

export function createInMemoryPushNotificationInbox(): PushNotificationInbox {
  return new InMemoryPushNotificationInboxModule();
}

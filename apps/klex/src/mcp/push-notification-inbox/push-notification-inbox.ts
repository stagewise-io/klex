import type { PushNotification } from '@stagewise/mcp-extension-push-notifications';

export interface PushNotificationInbox {
  commit(
    namespace: string,
    events: readonly PushNotification[],
  ): Promise<PushNotification[]>;
}

class InMemoryPushNotificationInboxModule implements PushNotificationInbox {
  private readonly eventIds = new Map<string, Set<string>>();

  async commit(
    namespace: string,
    events: readonly PushNotification[],
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
    return accepted.map((event) => structuredClone(event));
  }
}

export function createInMemoryPushNotificationInbox(): PushNotificationInbox {
  return new InMemoryPushNotificationInboxModule();
}

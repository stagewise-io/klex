import type { EventDescriptor, EventsDeliveryMode } from '../spec.types.js';

export class NoCompatibleDeliveryModeError extends Error {
  constructor(
    readonly eventName: string,
    readonly offered: readonly EventsDeliveryMode[],
    readonly supported: readonly EventsDeliveryMode[],
  ) {
    super(
      `Event "${eventName}" offers [${offered.join(', ')}]; client supports [${supported.join(', ')}]`,
    );
    this.name = 'NoCompatibleDeliveryModeError';
  }
}

/**
 * Picks the first mode in `preference` that the server offers and the client
 * supports. Webhook is never selected unless the caller lists it.
 */
export function selectDeliveryMode(
  descriptor: Pick<EventDescriptor, 'name' | 'delivery'>,
  supported: readonly EventsDeliveryMode[],
  preference: readonly EventsDeliveryMode[] = ['push', 'poll'],
): EventsDeliveryMode {
  for (const mode of preference) {
    if (supported.includes(mode) && descriptor.delivery.includes(mode)) {
      return mode;
    }
  }
  throw new NoCompatibleDeliveryModeError(
    descriptor.name,
    descriptor.delivery,
    supported,
  );
}

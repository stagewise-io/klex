import type {
  MediaTransport,
  MediaTransportConnector,
} from '../media-transport';

export interface MediaTransportConnectorRegistration {
  readonly profile: string;
  readonly create: () => MediaTransportConnector;
}

export interface MediaTransportConnectorRegistry
  extends MediaTransportConnector {
  readonly profiles: readonly string[];
}

class MediaTransportConnectorRegistryModule
  implements MediaTransportConnectorRegistry
{
  readonly profiles: readonly string[];
  private readonly registrations = new Map<
    string,
    () => MediaTransportConnector
  >();
  private readonly connectors = new Map<string, MediaTransportConnector>();
  private closePromise: Promise<void> | undefined;

  constructor(registrations: readonly MediaTransportConnectorRegistration[]) {
    for (const registration of registrations) {
      if (registration.profile.length === 0)
        throw new Error('Media transport profile must not be empty');
      if (this.registrations.has(registration.profile))
        throw new Error(
          `Duplicate media transport profile: ${registration.profile}`,
        );
      this.registrations.set(registration.profile, registration.create);
    }
    this.profiles = [...this.registrations.keys()];
  }

  async connect(
    descriptor: unknown,
    options: { signal: AbortSignal },
  ): Promise<MediaTransport> {
    if (this.closePromise)
      throw new Error('Media transport connector registry is closed');
    const profile = profileFromDescriptor(descriptor);
    const create = this.registrations.get(profile);
    if (!create)
      throw new Error(`Unsupported media transport profile: ${profile}`);
    let connector = this.connectors.get(profile);
    if (!connector) {
      connector = create();
      this.connectors.set(profile, connector);
    }
    return connector.connect(descriptor, options);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await Promise.allSettled(
        [...this.connectors.values()].map((connector) => connector.close()),
      );
      this.connectors.clear();
    })();
    return this.closePromise;
  }
}

export function createMediaTransportConnectorRegistry(
  registrations: readonly MediaTransportConnectorRegistration[],
): MediaTransportConnectorRegistry {
  return new MediaTransportConnectorRegistryModule(registrations);
}

function profileFromDescriptor(descriptor: unknown): string {
  if (
    typeof descriptor !== 'object' ||
    descriptor === null ||
    !('profile' in descriptor) ||
    typeof descriptor.profile !== 'string' ||
    descriptor.profile.length === 0
  )
    throw new Error('Media transport descriptor has no valid profile');
  return descriptor.profile;
}

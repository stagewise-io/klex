import { describe, expect, it, vi } from 'vitest';

import type { MediaTransportConnector } from '@/media-transport';

import { createMediaTransportConnectorRegistry } from './connector-registry';

function connector() {
  return {
    connect: vi.fn(async () => ({ id: 'transport' })),
    close: vi.fn(async () => undefined),
  } as unknown as MediaTransportConnector;
}

describe('MediaTransportConnectorRegistry', () => {
  it('dispatches by profile and lazily caches connectors', async () => {
    const livekit = connector();
    const create = vi.fn(() => livekit);
    const registry = createMediaTransportConnectorRegistry([
      { profile: 'livekit-room', create },
    ]);
    const signal = new AbortController().signal;
    const descriptor = { profile: 'livekit-room', token: 'secret' };
    await registry.connect(descriptor, { signal });
    await registry.connect(descriptor, { signal });
    expect(registry.profiles).toEqual(['livekit-room']);
    expect(create).toHaveBeenCalledOnce();
    expect(livekit.connect).toHaveBeenCalledTimes(2);
    expect(livekit.connect).toHaveBeenCalledWith(descriptor, { signal });
  });

  it('rejects malformed and unsupported descriptors', async () => {
    const registry = createMediaTransportConnectorRegistry([]);
    await expect(
      registry.connect({}, { signal: new AbortController().signal }),
    ).rejects.toThrow('no valid profile');
    await expect(
      registry.connect(
        { profile: 'unknown' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('Unsupported media transport profile: unknown');
  });

  it('rejects duplicate registrations', () => {
    expect(() =>
      createMediaTransportConnectorRegistry([
        { profile: 'same', create: connector },
        { profile: 'same', create: connector },
      ]),
    ).toThrow('Duplicate media transport profile: same');
  });

  it('closes only created connectors and is idempotent', async () => {
    const created = connector();
    const unused = connector();
    const registry = createMediaTransportConnectorRegistry([
      { profile: 'created', create: () => created },
      { profile: 'unused', create: () => unused },
    ]);
    await registry.connect(
      { profile: 'created' },
      { signal: new AbortController().signal },
    );
    await Promise.all([registry.close(), registry.close()]);
    expect(created.close).toHaveBeenCalledOnce();
    expect(unused.close).not.toHaveBeenCalled();
    await expect(
      registry.connect(
        { profile: 'created' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('registry is closed');
  });
});

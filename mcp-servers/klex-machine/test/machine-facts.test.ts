import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMachineFactsCollector,
  encodeMachineFactsHeader,
  type MachineFacts,
  type MachineFactsProbes,
  prettyOsName,
} from '../src/cloud/facts/index.js';

function probes(
  overrides: Partial<MachineFactsProbes> = {},
): MachineFactsProbes {
  return {
    platform: () => 'linux',
    arch: () => 'arm64',
    release: () => '6.1',
    version: () => 'Windows 11',
    cpuModel: () => ' CPU ',
    availableParallelism: () => 4,
    totalmem: () => 8 * 1024 ** 3,
    hostname: () => 'work-host',
    readOsRelease: async () => 'PRETTY_NAME="Ubuntu 24.04"',
    volumeBytes: async () => 100n * 1024n ** 3n,
    ...overrides,
  };
}
const options = {
  cwd: '/work/日本語',
  version: '0.1.0',
  omitHostDetails: false,
};
afterEach(() => vi.useRealTimers());

describe('machine facts', () => {
  it('collects runtime-visible facts and round-trips Unicode', async () => {
    const facts = await createMachineFactsCollector(
      options,
      probes(),
    ).collect();
    expect(facts).toEqual({
      v: 1,
      machineVersion: '0.1.0',
      os: {
        platform: 'linux',
        arch: 'arm64',
        release: '6.1',
        name: 'Ubuntu 24.04',
      },
      cpu: { model: 'CPU', logicalCores: 4 },
      memory: { totalBytes: 8 * 1024 ** 3 },
      host: {
        hostname: 'work-host',
        workspacePath: options.cwd,
        workspaceVolumeTotalBytes: 100 * 1024 ** 3,
      },
    });
    const header = encodeMachineFactsHeader(facts);
    expect(header).toBeDefined();
    expect(
      JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8')),
    ).toEqual(facts);
  });

  it.each(['darwin', 'win32'])(
    'uses OS description on %s without reading Linux files',
    async (platform) => {
      const readOsRelease = vi.fn();
      const facts = await createMachineFactsCollector(
        options,
        probes({ platform: () => platform, readOsRelease }),
      ).collect();
      expect(facts.os.name).toBe('Windows 11');
      expect(readOsRelease).not.toHaveBeenCalled();
    },
  );

  it('omits host details without probing hostname or volume', async () => {
    const hostname = vi.fn();
    const volumeBytes = vi.fn();
    const facts = await createMachineFactsCollector(
      { ...options, omitHostDetails: true },
      probes({ hostname, volumeBytes }),
    ).collect();
    expect(facts).not.toHaveProperty('host');
    expect(hostname).not.toHaveBeenCalled();
    expect(volumeBytes).not.toHaveBeenCalled();
  });

  it('falls back to the second os-release file and treats input as data', async () => {
    const readOsRelease = vi
      .fn()
      .mockRejectedValueOnce(new Error())
      .mockResolvedValue('PRETTY_NAME="$(do-not-execute)"');
    const facts = await createMachineFactsCollector(
      options,
      probes({ readOsRelease }),
    ).collect();
    expect(facts.os.name).toBe('$(do-not-execute)');
    expect(readOsRelease.mock.calls.map((call) => call[0])).toEqual([
      '/etc/os-release',
      '/usr/lib/os-release',
    ]);
    expect(prettyOsName('PRETTY_NAME="unterminated')).toBeUndefined();
    expect(prettyOsName(`PRETTY_NAME="${'x'.repeat(20_000)}"`)).toBeUndefined();
  });

  it('omits failed probes, unsafe numbers and oversized paths', async () => {
    const fail = () => {
      throw new Error('unavailable');
    };
    const facts = await createMachineFactsCollector(
      { ...options, cwd: '/'.repeat(1025) },
      probes({
        release: fail,
        cpuModel: () => 'x'.repeat(300),
        availableParallelism: () => 0,
        totalmem: () => Infinity,
        hostname: fail,
        readOsRelease: async () => {
          throw new Error();
        },
        volumeBytes: async () => BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    ).collect();
    expect(JSON.parse(JSON.stringify(facts))).toEqual({
      v: 1,
      machineVersion: '0.1.0',
      os: { platform: 'linux', arch: 'arm64' },
      cpu: { model: 'x'.repeat(256) },
      memory: {},
      host: {},
    });
  });

  it('omits unsupported statfs results', async () => {
    const facts = await createMachineFactsCollector(
      options,
      probes({
        volumeBytes: async () => {
          throw new Error('ENOSYS');
        },
      }),
    ).collect();
    expect(facts.host?.workspaceVolumeTotalBytes).toBeUndefined();
  });

  it('returns within one second and does not mutate on delayed probe completion', async () => {
    vi.useFakeTimers();
    let resolve: ((value: bigint) => void) | undefined;
    const result = createMachineFactsCollector(
      options,
      probes({
        volumeBytes: () =>
          new Promise((r) => {
            resolve = r;
          }),
      }),
    ).collect();
    await vi.advanceTimersByTimeAsync(1000);
    const facts = await result;
    resolve?.(42n);
    await Promise.resolve();
    expect(facts.host?.workspaceVolumeTotalBytes).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes probes for each collection and bounds encoded bytes', async () => {
    const hostname = vi
      .fn()
      .mockReturnValueOnce('first')
      .mockReturnValueOnce('second');
    const collector = createMachineFactsCollector(
      options,
      probes({ hostname }),
    );
    expect((await collector.collect()).host?.hostname).toBe('first');
    const second = await collector.collect();
    expect(second.host?.hostname).toBe('second');
    const oversized: MachineFacts = {
      ...second,
      host: { workspacePath: '🙂'.repeat(1024) },
    };
    expect(encodeMachineFactsHeader(oversized)).toBeUndefined();
  });
});

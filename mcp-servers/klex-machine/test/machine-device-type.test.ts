import { describe, expect, it, vi } from 'vitest';

import { detectMachineDeviceType } from '../src/cloud/facts/device-type.js';

function probes() {
  return {
    read: vi.fn(
      async (_path: string, _signal: AbortSignal): Promise<string> => {
        throw new Error('Unavailable');
      },
    ),
    run: vi.fn(
      async (
        _file: string,
        _args: string[],
        _signal: AbortSignal,
      ): Promise<string> => {
        throw new Error('Unavailable');
      },
    ),
  };
}
const signal = () => new AbortController().signal;

describe('machine device type', () => {
  it.each([
    ['MacBook Air', 'Mac16,12', 'laptop'],
    ['Mac mini', 'Mac16,10', 'desktop'],
    ['Mac Studio', 'Mac14,13', 'desktop'],
    ['Apple Virtual Machine', 'VirtualMac2,1', 'vm'],
    ['', 'VirtualMac2,1', 'vm'],
    ['Future Mac', 'Mac99,1', undefined],
  ])(
    'classifies macOS model %s without guessing from the identifier',
    async (name, model, expected) => {
      const io = probes();
      io.run.mockResolvedValue(
        JSON.stringify({
          SPHardwareDataType: [{ machine_name: name, machine_model: model }],
        }),
      );
      expect(await detectMachineDeviceType('darwin', signal(), io)).toBe(
        expected,
      );
      expect(io.run.mock.calls[0]?.slice(0, 2)).toEqual([
        '/usr/sbin/system_profiler',
        ['SPHardwareDataType', '-json'],
      ]);
    },
  );

  it.each([
    [[9], 'Laptop model', 'laptop'],
    [[7], 'Tower model', 'desktop'],
    [[23], 'Rack model', 'server'],
    [[3], 'VMware Virtual Platform', 'vm'],
    [[2], 'Unknown model', undefined],
  ])(
    'classifies Windows chassis %j and model %s',
    async (chassis, model, expected) => {
      const io = probes();
      io.run.mockResolvedValue(JSON.stringify({ model, chassis }));
      expect(await detectMachineDeviceType('win32', signal(), io)).toBe(
        expected,
      );
    },
  );

  it.each([
    ['9', 'laptop'],
    ['3', 'desktop'],
    ['23', 'server'],
    ['2', undefined],
  ])(
    'uses Linux DMI chassis %s when virtualization tools are unavailable',
    async (chassis, expected) => {
      const io = probes();
      io.read.mockImplementation(async (path) => {
        if (path.endsWith('/chassis_type')) return chassis;
        throw new Error('Unavailable');
      });
      expect(await detectMachineDeviceType('linux', signal(), io)).toBe(
        expected,
      );
    },
  );

  it('uses container markers before host DMI', async () => {
    const io = probes();
    io.read.mockImplementation(async (path) => {
      if (path === '/.dockerenv') return '';
      if (path.endsWith('/chassis_type')) return '9';
      throw new Error('Unavailable');
    });
    expect(await detectMachineDeviceType('linux', signal(), io)).toBe(
      'container',
    );
    expect(io.run).not.toHaveBeenCalled();
    expect(io.read.mock.calls.some(([path]) => path.includes('/dmi/'))).toBe(
      false,
    );
  });

  it.each([
    ['--container', 'docker', 'container'],
    ['--vm', 'kvm', 'vm'],
  ])(
    'uses systemd virtualization detection %s',
    async (flag, value, expected) => {
      const io = probes();
      io.run.mockImplementation(async (_file, args) => {
        if (args[0] === flag) return value;
        throw new Error('Not detected');
      });
      expect(await detectMachineDeviceType('linux', signal(), io)).toBe(
        expected,
      );
    },
  );

  it('recognizes virtual DMI when systemd is unavailable', async () => {
    const io = probes();
    io.read.mockImplementation(async (path) => {
      if (path.endsWith('/product_name')) return 'VirtualBox';
      if (path.endsWith('/chassis_type')) return '3';
      throw new Error('Unavailable');
    });
    expect(await detectMachineDeviceType('linux', signal(), io)).toBe('vm');
  });

  it('omits unsupported, malformed and unavailable information', async () => {
    const io = probes();
    expect(
      await detectMachineDeviceType('freebsd', signal(), io),
    ).toBeUndefined();
    expect(io.run).not.toHaveBeenCalled();
    expect(
      await detectMachineDeviceType('linux', signal(), io),
    ).toBeUndefined();
    io.run.mockResolvedValue('not json');
    expect(
      await detectMachineDeviceType('darwin', signal(), io),
    ).toBeUndefined();
    io.run.mockResolvedValue('{"chassis":"laptop","model":"PC"}');
    expect(
      await detectMachineDeviceType('win32', signal(), io),
    ).toBeUndefined();
  });
});

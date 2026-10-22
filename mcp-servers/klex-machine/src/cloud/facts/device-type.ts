import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { z } from 'zod';

export type MachineDeviceType =
  | 'laptop'
  | 'desktop'
  | 'server'
  | 'vm'
  | 'container';

const execute = promisify(execFile);
const probes = {
  read: (path: string, signal: AbortSignal) =>
    readFile(path, { encoding: 'utf8', signal }),
  run: async (file: string, args: string[], signal: AbortSignal) =>
    (
      await execute(file, args, {
        encoding: 'utf8',
        signal,
        timeout: 900,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      })
    ).stdout.trim(),
};

const macHardware = z.object({
  SPHardwareDataType: z.array(
    z.object({
      machine_name: z.string().optional(),
      machine_model: z.string().optional(),
    }),
  ),
});
const windowsHardware = z.object({
  model: z.string(),
  chassis: z.array(z.number()),
});

function chassisType(value: number): MachineDeviceType | undefined {
  if ([8, 9, 10, 14, 31, 32].includes(value)) return 'laptop';
  if ([3, 4, 5, 6, 7, 13, 15, 16, 24, 35, 36].includes(value)) return 'desktop';
  if ([23, 28, 29].includes(value)) return 'server';
  return undefined;
}

function virtualModel(model: string) {
  return /\b(virtual|virtualmac|vmware|virtualbox|kvm|qemu|xen|hvm|bochs|parallels)(?:\b|\d)/i.test(
    model,
  );
}

/** Best-effort form factor, never inferred from an editable hostname. */
export async function detectMachineDeviceType(
  platform: string,
  signal: AbortSignal,
  io = probes,
): Promise<MachineDeviceType | undefined> {
  try {
    if (platform === 'darwin') {
      const result = macHardware.parse(
        JSON.parse(
          await io.run(
            '/usr/sbin/system_profiler',
            ['SPHardwareDataType', '-json'],
            signal,
          ),
        ),
      );
      const model = result.SPHardwareDataType.map(
        (item) => `${item.machine_name ?? ''} ${item.machine_model ?? ''}`,
      ).join(' ');
      if (virtualModel(model)) return 'vm';
      if (/MacBook/i.test(model)) return 'laptop';
      if (/iMac|Mac (mini|Studio|Pro)|Macmini|MacPro|MacStudio/i.test(model))
        return 'desktop';
      if (/Xserve/i.test(model)) return 'server';
      return undefined;
    }
    if (platform === 'win32') {
      const result = windowsHardware.parse(
        JSON.parse(
          await io.run(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '$s = Get-CimInstance Win32_ComputerSystem; $c = Get-CimInstance Win32_SystemEnclosure; @{model=$s.Model; chassis=@($c.ChassisTypes)} | ConvertTo-Json -Compress',
            ],
            signal,
          ),
        ),
      );
      if (virtualModel(result.model)) return 'vm';
      return result.chassis.map(chassisType).find((type) => type !== undefined);
    }
    if (platform !== 'linux') return undefined;

    // Containers can expose their host's DMI data. Detect them before chassis.
    const markers = await Promise.all(
      ['/.dockerenv', '/run/.containerenv', '/run/systemd/container'].map(
        (path) =>
          io.read(path, signal).then(
            () => true,
            () => false,
          ),
      ),
    );
    if (markers.some(Boolean)) return 'container';
    const container = await io
      .run('systemd-detect-virt', ['--container'], signal)
      .catch(() => undefined);
    if (container && container !== 'none') return 'container';
    const vm = await io
      .run('systemd-detect-virt', ['--vm'], signal)
      .catch(() => undefined);
    if (vm && vm !== 'none') return 'vm';
    const [model, chassis] = await Promise.all([
      io.read('/sys/class/dmi/id/product_name', signal).catch(() => ''),
      io.read('/sys/class/dmi/id/chassis_type', signal).catch(() => ''),
    ]);
    if (virtualModel(model)) return 'vm';
    return chassisType(Number(chassis.trim()));
  } catch {
    return undefined;
  }
}

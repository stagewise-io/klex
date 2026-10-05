import { afterEach, describe, expect, it, vi } from 'vitest';

import { MachinePathResolver } from '../src/filesystem/index.js';
import {
  stripAnsi,
  tail,
  type WatcherCompletion,
} from '../src/notifications/index.js';
import { WatcherService } from '../src/watchers/index.js';

const services: WatcherService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  vi.useRealTimers();
});
function setup(max = 32, now = Date.now) {
  const completions: WatcherCompletion[] = [];
  const onCancel = vi.fn(async () => {});
  const onError = vi.fn();
  const service = new WatcherService(
    new MachinePathResolver(process.cwd()),
    {
      onStart: async () => {},
      onFinish: async (_info, completion) => {
        completions.push(completion);
      },
      onCancel,
      onError,
    },
    max,
    now,
  );
  services.push(service);
  return { service, completions, onCancel, onError };
}
const longCommand = `"${process.execPath}" -e "setInterval(()=>{},1000)"`;
const input = (command: string) => ({
  command,
  title: 'test',
  timeoutMs: 10000,
});

describe('watchers', () => {
  it.each([0, 3])('reports exit %s exactly once', async (code) => {
    const { service, completions } = setup();
    await service.create(input(`exit ${code}`));
    await expect.poll(() => completions.length).toBe(1);
    expect(completions[0]).toMatchObject({
      outcome: code === 0 ? 'condition_met' : 'failed',
      exitCode: code,
    });
  });
  it('cancels without notifying and enforces the running bound', async () => {
    const { service, completions, onCancel } = setup(1);
    const watcher = await service.create(input(longCommand));
    await expect(service.create(input(longCommand))).rejects.toThrow(
      'Watcher limit',
    );
    await service.cancel(watcher.id);
    expect(onCancel).toHaveBeenCalledWith(watcher.id);
    expect(service.list()).toEqual([]);
    expect(completions).toEqual([]);
  });
  it('checks wall-clock deadlines and kills the process group', async () => {
    let now = Date.now();
    const { service, completions } = setup(32, () => now);
    const watcher = await service.create(input(longCommand));
    now += 20000;
    await expect
      .poll(() => completions[0]?.outcome, { timeout: 7000 })
      .toBe('timed_out');
    if (process.platform !== 'win32' && watcher.pid) {
      await expect
        .poll(() => {
          try {
            process.kill(-Number(watcher.pid), 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    }
  }, 10000);
  it('limits event tails and strips terminal escapes', () => {
    expect(tail('x'.repeat(5000))).toEqual({
      text: 'x'.repeat(4096),
      truncated: true,
    });
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });
  it('rejects watcher lifetimes beyond seven days', async () => {
    const { service } = setup();
    await expect(
      service.create({ ...input('exit 0'), timeoutMs: 604800001 }),
    ).rejects.toThrow('timeoutMs');
  });
});

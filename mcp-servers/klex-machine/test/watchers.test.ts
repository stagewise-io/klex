import { afterEach, describe, expect, it, vi } from 'vitest';

import { MachinePathResolver } from '../src/filesystem/index.js';
import {
  stripAnsi,
  tail,
  type WatcherCompletion,
} from '../src/notifications/index.js';
import { WatcherService } from '../src/watchers/index.js';

const services: WatcherService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.closeAll();
  vi.useRealTimers();
});
function setup(
  max = 32,
  now = Date.now,
  hooks: Partial<ConstructorParameters<typeof WatcherService>[1]> = {},
) {
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
      ...hooks,
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = Date.now();
    const { service, completions } = setup(32, () => now);
    const watcher = await service.create(input(longCommand));
    now += 20000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(completions[0]?.outcome).toBe('timed_out');
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    if (process.platform !== 'win32' && watcher.pid) {
      await expect
        .poll(
          () => {
            try {
              process.kill(-Number(watcher.pid), 0);
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 6000 },
        )
        .toBe(false);
    }
  }, 10000);
  it.each([0, 900])(
    'enforces a one-second deadline after %i ms of persistence',
    async (persistenceMs) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let now = Date.now();
      const { service, completions } = setup(32, () => now, {
        onStart: async () => {
          now += persistenceMs;
        },
      });
      await service.create({ ...input(longCommand), timeoutMs: 1000 });
      const remaining = 1000 - persistenceMs;
      now += remaining - 1;
      await vi.advanceTimersByTimeAsync(remaining - 1);
      expect(completions).toEqual([]);
      now += 1;
      await vi.advanceTimersByTimeAsync(1);
      expect(completions[0]?.outcome).toBe('timed_out');
      await vi.advanceTimersByTimeAsync(5000);
    },
  );
  it('does not spawn commands whose deadline expired during persistence', async () => {
    let now = Date.now();
    const { service, completions } = setup(32, () => now, {
      onStart: async () => {
        now += 20000;
      },
    });
    const watcher = await service.create(input('exit 0'));
    expect(watcher.pid).toBeNull();
    expect(completions[0]?.outcome).toBe('timed_out');
  });
  it('rejects an interrupted create and drains its reservation before shutdown', async () => {
    const records = new Set<string>();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const { service, completions } = setup(32, Date.now, {
      onStart: async (info) => {
        records.add(info.id);
        started.resolve();
        await gate.promise;
      },
      onCancel: async (id) => {
        records.delete(id);
      },
    });
    const creation = service.create(input('exit 0'));
    const rejected = expect(creation).rejects.toThrow(
      'interrupted before starting',
    );
    await started.promise;
    let closed = false;
    const closing = service.closeAll().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    gate.resolve();
    await rejected;
    await closing;
    expect(records.size).toBe(0);
    expect(completions).toEqual([]);
    expect(service.list()).toEqual([]);
  });
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

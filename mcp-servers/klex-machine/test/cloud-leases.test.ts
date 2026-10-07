import { UnsecuredJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMachineLeaseReporter,
  MAX_REPORT_WORKLOADS,
  type MachineLeaseReporter,
  WorkloadLeaseError,
} from '../src/cloud/lease-reporter.js';
import { createPrincipalMcpRouter } from '../src/cloud/principal-router.js';
import { silentMachineLogger } from '../src/logger.js';
import type { MachineMcp } from '../src/mcp.js';
import { createNotificationStore } from '../src/notifications/index.js';
import { WorkloadTracker } from '../src/workloads/index.js';

interface ReportedWorkload {
  clientId: string;
  workloadId: string;
  action: 'acquire' | 'renew' | 'release';
}

/** Minimal Cloud: per-workload outcomes, request-level status overrides. */
function fakeCloud() {
  const reports: { generation: number; workloads: ReportedWorkload[] }[] = [];
  const held = new Map<string, string>();
  const expired = new Set<string>();
  const state: {
    generation: number;
    status: number;
    hold?: Promise<void>;
  } = { generation: 1, status: 200 };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      generation: number;
      workloads: ReportedWorkload[];
    };
    reports.push(body);
    await state.hold;
    if (state.status !== 200)
      return new Response('{}', { status: state.status });
    const workloads = body.workloads.map((workload) => {
      if (workload.action === 'release') {
        held.delete(workload.workloadId);
        return { workloadId: workload.workloadId, expiresAt: null };
      }
      if (expired.has(workload.workloadId))
        return {
          workloadId: workload.workloadId,
          error: 'workload_lease_expired',
        };
      if (workload.action === 'renew' && !held.has(workload.workloadId))
        return {
          workloadId: workload.workloadId,
          error: 'workload_lease_expired',
        };
      held.set(workload.workloadId, workload.clientId);
      return { workloadId: workload.workloadId, expiresAt: 'later' };
    });
    return Response.json({ generation: body.generation, workloads });
  });
  return { fetch, reports, held, expired, state };
}

const reporters: MachineLeaseReporter[] = [];
afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.close();
});

function setup() {
  const cloud = fakeCloud();
  const errors: unknown[] = [];
  const invalidateToken = vi.fn();
  const reporter = createMachineLeaseReporter({
    reportUrl: 'https://cloud.test/api/machines/m/lifecycle/report',
    getToken: async () =>
      new UnsecuredJWT({ machine_generation: cloud.state.generation }).encode(),
    invalidateToken,
    fetch: cloud.fetch,
    renewIntervalMs: 60_000,
    retryDelayMs: 60_000,
    onError: (error) => errors.push(error),
  });
  reporters.push(reporter);
  return { cloud, errors, invalidateToken, reporter };
}

const last = (cloud: ReturnType<typeof fakeCloud>) =>
  cloud.reports.at(-1)?.workloads ?? [];

describe('machine lease reporter', () => {
  it('reports nothing while idle', async () => {
    const { cloud, reporter } = setup();
    reporter.track('client-a', new WorkloadTracker());
    await reporter.flush();
    expect(cloud.fetch).not.toHaveBeenCalled();
  });

  it('acquires, renews while active and releases exactly once', async () => {
    const { cloud, reporter } = setup();
    const tracker = new WorkloadTracker();
    reporter.track('client-a', tracker);
    const handle = tracker.acquire({ kind: 'command', subjectId: 'cmd' });
    await reporter.flush();
    expect(last(cloud)).toEqual([
      {
        clientId: 'client-a',
        workloadId: expect.any(String),
        action: 'acquire',
      },
    ]);
    const leaseId = last(cloud)[0]?.workloadId;
    await reporter.flush();
    expect(last(cloud)).toEqual([
      { clientId: 'client-a', workloadId: leaseId, action: 'renew' },
    ]);
    handle.release();
    handle.release();
    await reporter.flush();
    expect(last(cloud)).toEqual([
      { clientId: 'client-a', workloadId: leaseId, action: 'release' },
    ]);
    const count = cloud.reports.length;
    await reporter.flush();
    expect(cloud.reports).toHaveLength(count);
    expect(cloud.held.size).toBe(0);
  });

  it('keeps successful leases and replaces only the expired one', async () => {
    const { cloud, errors, reporter } = setup();
    const tracker = new WorkloadTracker();
    reporter.track('client-a', tracker);
    tracker.acquire({ kind: 'command', subjectId: 'one' });
    tracker.acquire({ kind: 'command', subjectId: 'two' });
    await reporter.flush();
    const [first, second] = last(cloud).map((item) => item.workloadId);
    cloud.expired.add(second ?? '');
    await reporter.flush();
    expect(errors).toEqual([expect.any(WorkloadLeaseError)]);
    await reporter.flush();
    const next = last(cloud);
    expect(next).toContainEqual({
      clientId: 'client-a',
      workloadId: first,
      action: 'renew',
    });
    expect(next.map((item) => item.workloadId)).not.toContain(second);
    expect(next.filter((item) => item.action === 'acquire')).toHaveLength(1);
  });

  it('retries whole-request failures without losing lease state', async () => {
    const { cloud, invalidateToken, reporter } = setup();
    const tracker = new WorkloadTracker();
    reporter.track('client-a', tracker);
    const handle = tracker.acquire({ kind: 'command', subjectId: 'cmd' });
    await reporter.flush();
    const leaseId = last(cloud)[0]?.workloadId;
    cloud.state.status = 409;
    await reporter.flush();
    expect(invalidateToken).toHaveBeenCalledOnce();
    handle.release();
    cloud.state.status = 503;
    await reporter.flush();
    cloud.state.status = 200;
    await reporter.flush();
    expect(last(cloud)).toEqual([
      { clientId: 'client-a', workloadId: leaseId, action: 'release' },
    ]);
    expect(cloud.held.size).toBe(0);
  });

  it('releases a lease whose acquire was still in flight', async () => {
    const { cloud, reporter } = setup();
    const tracker = new WorkloadTracker();
    reporter.track('client-a', tracker);
    let respond: () => void = () => undefined;
    cloud.state.hold = new Promise((resolve) => {
      respond = resolve;
    });
    const handle = tracker.acquire({ kind: 'command', subjectId: 'cmd' });
    const inFlight = reporter.flush();
    await vi.waitFor(() => expect(cloud.fetch).toHaveBeenCalledOnce());
    handle.release();
    respond();
    await inFlight;
    delete cloud.state.hold;
    await reporter.flush();
    expect(cloud.reports.map((report) => report.workloads[0]?.action)).toEqual([
      'acquire',
      'release',
    ]);
    expect(cloud.held.size).toBe(0);
  });

  it('drops work that ended before it was ever reported', async () => {
    const { cloud, reporter } = setup();
    const tracker = new WorkloadTracker();
    reporter.track('client-a', tracker);
    tracker.acquire({ kind: 'command', subjectId: 'cmd' }).release();
    await reporter.flush();
    expect(cloud.fetch).not.toHaveBeenCalled();
  });

  it('acquires fresh leases after a generation change', async () => {
    const { cloud, reporter } = setup();
    const tracker = new WorkloadTracker();
    reporter.track('client-a', tracker);
    tracker.acquire({ kind: 'command', subjectId: 'cmd' });
    await reporter.flush();
    const leaseId = last(cloud)[0]?.workloadId;
    cloud.state.generation = 2;
    await reporter.flush();
    expect(cloud.reports.at(-1)?.generation).toBe(2);
    expect(last(cloud)).toEqual([
      {
        clientId: 'client-a',
        workloadId: expect.any(String),
        action: 'acquire',
      },
    ]);
    expect(last(cloud)[0]?.workloadId).not.toBe(leaseId);
  });

  it('splits large workload sets so every lease is renewed', async () => {
    const { cloud, reporter } = setup();
    const tracker = new WorkloadTracker();
    reporter.track('client-a', tracker);
    for (let index = 0; index < MAX_REPORT_WORKLOADS + 5; index++)
      tracker.acquire({ kind: 'command', subjectId: `cmd-${index}` });
    await reporter.flush();
    cloud.reports.length = 0;
    await reporter.flush();
    expect(cloud.reports.map((report) => report.workloads.length)).toEqual([
      MAX_REPORT_WORKLOADS,
      5,
    ]);
    expect(
      cloud.reports.every((report) =>
        report.workloads.every((item) => item.action === 'renew'),
      ),
    ).toBe(true);
  });

  it('keeps principals isolated and releases on untrack', async () => {
    const { cloud, reporter } = setup();
    const a = new WorkloadTracker();
    const b = new WorkloadTracker();
    const untrackA = reporter.track('client-a', a);
    reporter.track('client-b', b);
    a.acquire({ kind: 'command', subjectId: 'a' });
    b.acquire({ kind: 'command', subjectId: 'b' });
    await reporter.flush();
    expect(new Set(cloud.held.values())).toEqual(
      new Set(['client-a', 'client-b']),
    );
    untrackA();
    await reporter.flush();
    expect([...cloud.held.values()]).toEqual(['client-b']);
  });

  it('stops reporting after close', async () => {
    const { cloud, reporter } = setup();
    const tracker = new WorkloadTracker();
    reporter.track('client-a', tracker);
    reporter.close();
    tracker.acquire({ kind: 'command', subjectId: 'cmd' });
    await reporter.flush();
    expect(cloud.fetch).not.toHaveBeenCalled();
  });

  it('never renews leases of a previous daemon process after restart', async () => {
    const { cloud, reporter } = setup();
    const before = new WorkloadTracker();
    reporter.track('client-a', before);
    before.acquire({ kind: 'command', subjectId: 'cmd' });
    await reporter.flush();
    const orphaned = last(cloud)[0]?.workloadId;
    // A crash ends the process without a release; Cloud's TTL expires the lease.
    reporter.close();

    const restarted = createMachineLeaseReporter({
      reportUrl: 'https://cloud.test/api/machines/m/lifecycle/report',
      getToken: async () =>
        new UnsecuredJWT({
          machine_generation: cloud.state.generation,
        }).encode(),
      invalidateToken: vi.fn(),
      fetch: cloud.fetch,
      renewIntervalMs: 60_000,
      retryDelayMs: 60_000,
    });
    reporters.push(restarted);
    const after = new WorkloadTracker();
    restarted.track('client-a', after);
    const count = cloud.reports.length;
    await restarted.flush();
    expect(cloud.reports).toHaveLength(count);

    after.acquire({ kind: 'command', subjectId: 'cmd' });
    await restarted.flush();
    expect(last(cloud)).toEqual([
      {
        clientId: 'client-a',
        workloadId: expect.not.stringMatching(`^${orphaned}$`),
        action: 'acquire',
      },
    ]);
    expect(
      cloud.reports
        .slice(count)
        .flatMap((report) => report.workloads)
        .some((workload) => workload.workloadId === orphaned),
    ).toBe(false);
  });
});

describe('principal router lease reporting', () => {
  it('tracks existing and future principals under their client id', async () => {
    const tracked: string[] = [];
    const reporter: MachineLeaseReporter = {
      track: (clientId) => {
        tracked.push(clientId);
        return () => undefined;
      },
      flush: async () => undefined,
      close: () => undefined,
    };
    let principal = 'client-a';
    const notifications = createNotificationStore({
      logger: silentMachineLogger,
    });
    const router = createPrincipalMcpRouter(
      {
        authenticate: async () => principal,
        challenge: () => 'Bearer',
      },
      '/tmp',
      notifications,
      (): MachineMcp => ({
        workloads: new WorkloadTracker(),
        fetch: async () => new Response('ok'),
        close: async () => undefined,
      }),
    );
    await router.fetch(new Request('https://machine.test/mcp'));
    router.attachLeaseReporter(reporter);
    principal = 'client-b';
    await router.fetch(new Request('https://machine.test/mcp'));
    await router.fetch(new Request('https://machine.test/mcp'));
    expect(tracked).toEqual(['client-a', 'client-b']);
    await router.close();
    await notifications.close();
  });
});

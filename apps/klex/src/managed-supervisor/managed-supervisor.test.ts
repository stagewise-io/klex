import { describe, expect, it, vi } from 'vitest';

import { createManagedLeaseDeadline } from './managed-supervisor';
import type { ManagedLeaseRequest } from './protocol';

const request: ManagedLeaseRequest = {
  protocolVersion: 1,
  agentId: '00000000-0000-4000-8000-000000000001',
  activationId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
  attemptId: '00000000-0000-4000-8000-000000000004',
  podUid: '00000000-0000-4000-8000-000000000005',
  nonce: '00000000-0000-4000-8000-000000000006',
};
const response = {
  ...request,
  sequence: 1,
  mode: 'run',
  serverNow: '2026-01-01T00:00:00.000Z',
  fundedUntil: '2026-01-01T00:02:00.000Z',
};

function fixture() {
  let time = 0;
  return {
    deadline: createManagedLeaseDeadline(() => time),
    setTime: (next: number) => {
      time = next;
    },
  };
}

describe('managed lease monotonic deadline', () => {
  it('does not authorize startup before a valid response', () => {
    expect(fixture().deadline.observe()).toEqual({
      phase: 'waiting',
      hardStopAt: null,
      sequence: 0,
    });
  });
  it('subtracts the full RTT and scheduling margin', () => {
    const { deadline, setTime } = fixture();
    setTime(2_000);
    deadline.accept({ request, response, sentAt: 0 });
    expect(deadline.observe()).toEqual({
      phase: 'run',
      hardStopAt: 115_000,
      sequence: 1,
    });
    setTime(75_000);
    expect(deadline.observe().phase).toBe('drain');
    setTime(115_000);
    expect(deadline.observe().phase).toBe('expired');
  });
  it('cannot extend lifetime through backwards wall-clock changes', () => {
    const { deadline, setTime } = fixture();
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(2_000_000_000_000);
      deadline.accept({ request, response, sentAt: 0 });
      clock.mockReturnValue(0);
      setTime(115_000);
      expect(deadline.observe().phase).toBe('expired');
    } finally {
      clock.mockRestore();
    }
  });
  it('rejects delayed, replayed, and mismatched responses without erasing authorization', () => {
    const { deadline, setTime } = fixture();
    deadline.accept({ request, response, sentAt: 0 });
    setTime(3_001);
    expect(() => deadline.accept({ request, response, sentAt: 0 })).toThrow(
      'budget',
    );
    for (const key of [
      'nonce',
      'agentId',
      'activationId',
      'sessionId',
      'attemptId',
      'podUid',
    ] as const)
      expect(() =>
        deadline.accept({
          request,
          response: {
            ...response,
            [key]: '00000000-0000-4000-8000-000000000099',
          },
          sentAt: 3_001,
        }),
      ).toThrow('mismatch');
    expect(deadline.observe().hardStopAt).toBe(115_000);
  });
  it('accepts funded renewal before drain but rejects sequence rollback and rewriting', () => {
    const { deadline, setTime } = fixture();
    deadline.accept({ request, response, sentAt: 0 });
    setTime(60_000);
    const renewed = {
      ...response,
      sequence: 2,
      serverNow: '2026-01-01T00:01:00.000Z',
      fundedUntil: '2026-01-01T00:03:00.000Z',
    };
    deadline.accept({ request, response: renewed, sentAt: 60_000 });
    expect(deadline.observe().hardStopAt).toBe(175_000);
    expect(() =>
      deadline.accept({ request, response, sentAt: 60_000 }),
    ).toThrow('backwards');
    expect(() =>
      deadline.accept({
        request,
        response: { ...renewed, fundedUntil: '2026-01-01T00:04:00.000Z' },
        sentAt: 60_000,
      }),
    ).toThrow('sequence');
  });
  it('latches expiry drain even if a renewal arrives before observe was called', () => {
    const { deadline, setTime } = fixture();
    deadline.accept({ request, response, sentAt: 0 });
    setTime(75_000);
    expect(() =>
      deadline.accept({
        request,
        response: { ...response, sequence: 2 },
        sentAt: 75_000,
      }),
    ).toThrow('reversed');
    expect(deadline.observe().phase).toBe('drain');
  });
  it('cannot resurrect an expired child', () => {
    const { deadline, setTime } = fixture();
    deadline.accept({ request, response, sentAt: 0 });
    setTime(120_000);
    expect(() =>
      deadline.accept({
        request,
        response: { ...response, sequence: 2 },
        sentAt: 120_000,
      }),
    ).toThrow('reversed');
  });
  it('allows one funded ordinary drain but never resumes it', () => {
    const { deadline, setTime } = fixture();
    deadline.accept({ request, response, sentAt: 0 });
    setTime(10_000);
    deadline.accept({
      request,
      response: {
        ...response,
        sequence: 2,
        mode: 'drain',
        serverNow: '2026-01-01T00:00:10.000Z',
        fundedUntil: '2026-01-01T00:05:55.000Z',
      },
      sentAt: 10_000,
    });
    expect(deadline.observe()).toEqual({
      phase: 'drain',
      hardStopAt: 350_000,
      sequence: 2,
    });
    expect(() =>
      deadline.accept({
        request,
        response: { ...response, sequence: 3 },
        sentAt: 10_000,
      }),
    ).toThrow('resume');
  });
  it('never lengthens an unchanged sequence with a repeated response', () => {
    const { deadline, setTime } = fixture();
    deadline.accept({ request, response, sentAt: 0 });
    setTime(20_000);
    deadline.accept({ request, response, sentAt: 20_000 });
    expect(deadline.observe().hardStopAt).toBe(115_000);
  });
  it.each(['deny', 'run'])(
    'does not launch on denied or already expired funding: %s',
    (mode) => {
      const { deadline } = fixture();
      deadline.accept({
        request,
        response: { ...response, mode, fundedUntil: response.serverNow },
        sentAt: 0,
      });
      expect(deadline.observe().phase).toBe('expired');
    },
  );
});

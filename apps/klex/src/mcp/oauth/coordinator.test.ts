import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalOAuthAuthorizationCoordinator } from './coordinator';
import { LocalOAuthCallbackReceiver } from './local-callback';

const receivers: LocalOAuthCallbackReceiver[] = [];
const coordinators: LocalOAuthAuthorizationCoordinator[] = [];

async function startReceiver(): Promise<LocalOAuthCallbackReceiver> {
  const receiver = await LocalOAuthCallbackReceiver.start();
  receivers.push(receiver);
  return receiver;
}

async function sendCallback(
  receiver: LocalOAuthCallbackReceiver,
  state: string,
): Promise<void> {
  const callbackUrl = new URL(receiver.redirectUrl);
  callbackUrl.searchParams.set('code', `code-${state}`);
  callbackUrl.searchParams.set('state', state);
  await fetch(callbackUrl);
}

afterEach(async () => {
  await Promise.all(
    coordinators.splice(0).map((coordinator) => coordinator.close()),
  );
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
});

describe('LocalOAuthAuthorizationCoordinator', () => {
  it('presents authorization and returns validated callback parameters', async () => {
    const receiver = await startReceiver();
    const present = vi.fn(async () => {
      const callbackUrl = new URL(receiver.redirectUrl);
      callbackUrl.searchParams.set('code', 'approved');
      callbackUrl.searchParams.set('state', 'expected');
      await fetch(callbackUrl);
    });
    const coordinator = new LocalOAuthAuthorizationCoordinator(present);
    coordinators.push(coordinator);

    const result = await coordinator.authorize({
      authorizationUrl: new URL(
        'https://auth.example.com/authorize?state=expected',
      ),
      receiver,
      signal: new AbortController().signal,
      state: 'expected',
    });

    expect(present).toHaveBeenCalledOnce();
    expect(result.get('code')).toBe('approved');
  });

  it('runs three authorization attempts in FIFO order', async () => {
    const attemptReceivers = await Promise.all([
      startReceiver(),
      startReceiver(),
      startReceiver(),
    ]);
    const presentationOrder: string[] = [];
    const coordinator = new LocalOAuthAuthorizationCoordinator(
      vi.fn(async (authorizationUrl) => {
        const state = authorizationUrl.searchParams.get('state');
        if (state === null) throw new Error('Missing state');
        presentationOrder.push(state);
        const receiver = attemptReceivers[Number(state) - 1];
        if (!receiver) throw new Error(`Missing receiver for state ${state}`);
        await sendCallback(receiver, state);
      }),
    );
    coordinators.push(coordinator);

    const results = await Promise.all(
      attemptReceivers.map((receiver, index) => {
        const state = String(index + 1);
        return coordinator.authorize({
          authorizationUrl: new URL(
            `https://auth.example.com/authorize?state=${state}`,
          ),
          receiver,
          signal: new AbortController().signal,
          state,
        });
      }),
    );

    expect(presentationOrder).toEqual(['1', '2', '3']);
    expect(results.map((result) => result.get('code'))).toEqual([
      'code-1',
      'code-2',
      'code-3',
    ]);
  });

  it('does not serialize authorization across coordinator instances', async () => {
    const firstReceiver = await startReceiver();
    const secondReceiver = await startReceiver();
    let releasePresentations: (() => void) | undefined;
    const presentationGate = new Promise<void>((resolve) => {
      releasePresentations = resolve;
    });
    let presentations = 0;
    const createCoordinator = (receiver: LocalOAuthCallbackReceiver) => {
      const coordinator = new LocalOAuthAuthorizationCoordinator(async () => {
        presentations += 1;
        if (presentations === 2) releasePresentations?.();
        await presentationGate;
        await sendCallback(receiver, 'expected');
      });
      coordinators.push(coordinator);
      return coordinator;
    };

    const attempts = [firstReceiver, secondReceiver].map((receiver) =>
      createCoordinator(receiver).authorize({
        authorizationUrl: new URL(
          'https://auth.example.com/authorize?state=expected',
        ),
        receiver,
        signal: new AbortController().signal,
        state: 'expected',
      }),
    );

    await Promise.all(attempts);
    expect(presentations).toBe(2);
  });

  it('cancels active and queued authorization attempts during shutdown', async () => {
    const receiver = await startReceiver();
    const queuedReceiver = await startReceiver();
    let releasePresentation: (() => void) | undefined;
    let markPresentationStarted: (() => void) | undefined;
    const presentationGate = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    const presentationStarted = new Promise<void>((resolve) => {
      markPresentationStarted = resolve;
    });
    const present = vi.fn(() => {
      markPresentationStarted?.();
      return presentationGate;
    });
    const coordinator = new LocalOAuthAuthorizationCoordinator(present);
    coordinators.push(coordinator);
    const authorization = coordinator.authorize({
      authorizationUrl: new URL(
        'https://auth.example.com/authorize?state=expected',
      ),
      receiver,
      signal: new AbortController().signal,
      state: 'expected',
    });

    const queuedAuthorization = coordinator.authorize({
      authorizationUrl: new URL(
        'https://auth.example.com/authorize?state=queued',
      ),
      receiver: queuedReceiver,
      signal: new AbortController().signal,
      state: 'queued',
    });

    const rejection = expect(authorization).rejects.toThrow('canceled');
    const queuedRejection =
      expect(queuedAuthorization).rejects.toThrow('canceled');
    await presentationStarted;
    const closing = coordinator.close();
    releasePresentation?.();
    await closing;
    await Promise.all([rejection, queuedRejection]);
    expect(present).toHaveBeenCalledOnce();
  });
});

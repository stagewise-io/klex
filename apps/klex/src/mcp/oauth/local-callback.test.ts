import { afterEach, describe, expect, it } from 'vitest';

import { LocalOAuthCallbackReceiver } from './local-callback';

const receivers: LocalOAuthCallbackReceiver[] = [];

async function startReceiver(): Promise<LocalOAuthCallbackReceiver> {
  const receiver = await LocalOAuthCallbackReceiver.start();
  receivers.push(receiver);
  return receiver;
}

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
});

describe('LocalOAuthCallbackReceiver', () => {
  it('binds an ephemeral IPv4 loopback callback and accepts the matching state', async () => {
    const receiver = await startReceiver();
    expect(receiver.redirectUrl.hostname).toBe('127.0.0.1');
    expect(receiver.redirectUrl.port).not.toBe('');

    const callbackPromise = receiver.waitForCallback({
      state: 'expected',
      timeoutMs: 1_000,
    });
    const callbackUrl = new URL(receiver.redirectUrl);
    callbackUrl.searchParams.set('code', 'authorization-code');
    callbackUrl.searchParams.set('iss', 'https://auth.example.com');
    callbackUrl.searchParams.set('state', 'expected');

    const response = await fetch(callbackUrl);
    expect(response.status).toBe(200);
    const callback = await callbackPromise;
    expect(callback.get('code')).toBe('authorization-code');
    expect(callback.get('iss')).toBe('https://auth.example.com');
  });

  it('rejects an unknown state without consuming the active transaction', async () => {
    const receiver = await startReceiver();
    const callbackPromise = receiver.waitForCallback({
      state: 'expected',
      timeoutMs: 1_000,
    });
    const invalidUrl = new URL(receiver.redirectUrl);
    invalidUrl.searchParams.set('code', 'attacker-code');
    invalidUrl.searchParams.set('state', 'wrong');

    expect((await fetch(invalidUrl)).status).toBe(400);

    const validUrl = new URL(receiver.redirectUrl);
    validUrl.searchParams.set('code', 'valid-code');
    validUrl.searchParams.set('state', 'expected');
    expect((await fetch(validUrl)).status).toBe(200);
    expect((await callbackPromise).get('code')).toBe('valid-code');
  });

  it('surfaces provider denial without reflecting callback parameters', async () => {
    const receiver = await startReceiver();
    const callbackPromise = receiver.waitForCallback({
      state: 'expected',
      timeoutMs: 1_000,
    });
    const rejection =
      expect(callbackPromise).rejects.toThrow('denied or failed');
    const callbackUrl = new URL(receiver.redirectUrl);
    callbackUrl.searchParams.set('error', 'access_denied');
    callbackUrl.searchParams.set('error_description', 'The user canceled');
    callbackUrl.searchParams.set('state', 'expected');

    const response = await fetch(callbackUrl);
    expect(await response.text()).not.toContain('access_denied');
    await rejection;
  });

  it('times out and rejects late callbacks', async () => {
    const receiver = await startReceiver();
    await expect(
      receiver.waitForCallback({ state: 'expected', timeoutMs: 5 }),
    ).rejects.toThrow('timed out');

    const callbackUrl = new URL(receiver.redirectUrl);
    callbackUrl.searchParams.set('code', 'late-code');
    callbackUrl.searchParams.set('state', 'expected');
    expect((await fetch(callbackUrl)).status).toBe(410);
  });
});

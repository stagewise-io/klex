import { describe, expect, it, vi } from 'vitest';

import {
  type Soul,
  SoulError,
  type SoulErrorCode,
} from '@/session/chat/extensions/soul';

import {
  createSoul,
  createSoulRoute,
  getSoul,
  getSoulRoute,
  patchSoul,
  patchSoulRoute,
} from './soul';
import { setupTestApp } from './test-utils';

function setup() {
  const soul = {
    get: vi.fn<Soul['get']>(() => null),
    create: vi.fn<Soul['create']>(async () => 'Created soul'),
    update: vi.fn<Soul['update']>(async () => 'Updated soul'),
  };
  const app = setupTestApp((app) => {
    app.openapi(getSoulRoute, getSoul({ soul }));
    app.openapi(createSoulRoute, createSoul({ soul }));
    app.openapi(patchSoulRoute, patchSoul({ soul }));
  });
  function mutate(
    method: 'POST' | 'PATCH',
    body: unknown = { instructions: 'Be precise' },
  ) {
    return app.request('/v1/soul', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return { app, soul, mutate };
}

describe('Soul admin routes', () => {
  it('GET returns JSON null when no soul exists', async () => {
    const { app, soul } = setup();
    const response = await app.request('/v1/soul');
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(soul.create).not.toHaveBeenCalled();
    expect(soul.update).not.toHaveBeenCalled();
  });

  it('GET returns the existing soul directly, without an envelope', async () => {
    const { app, soul } = setup();
    soul.get.mockReturnValue('Existing soul');
    expect(await (await app.request('/v1/soul')).json()).toBe('Existing soul');
  });

  it('POST waits for creation and returns 201 with the generated document', async () => {
    const { soul, mutate } = setup();
    const response = await mutate('POST');
    expect(response.status).toBe(201);
    expect(await response.json()).toBe('Created soul');
    expect(soul.create).toHaveBeenCalledWith(
      'Be precise',
      expect.any(AbortSignal),
    );
    expect(soul.update).not.toHaveBeenCalled();
  });

  it('POST re-creates an existing soul without an opt-in flag', async () => {
    const { soul, mutate } = setup();
    soul.get.mockReturnValue('Existing soul');
    const response = await mutate('POST', {
      instructions: 'Start over',
    });
    expect(response.status).toBe(201);
    expect(soul.create).toHaveBeenCalledWith(
      'Start over',
      expect.any(AbortSignal),
    );
    expect(soul.update).not.toHaveBeenCalled();
  });

  it('PATCH waits for the update and returns 200 with the generated document', async () => {
    const { soul, mutate } = setup();
    const response = await mutate('PATCH');
    expect(response.status).toBe(200);
    expect(await response.json()).toBe('Updated soul');
    expect(soul.update).toHaveBeenCalledWith(
      'Be precise',
      expect.any(AbortSignal),
    );
    expect(soul.create).not.toHaveBeenCalled();
  });

  it.each([{}, { instructions: '' }, { instructions: '  ' }])(
    'PATCH accepts empty or omitted instructions for optimization (%j)',
    async (body) => {
      const { soul, mutate } = setup();
      const response = await mutate('PATCH', body);
      expect(response.status).toBe(200);
      expect(soul.update).toHaveBeenCalledWith('', expect.any(AbortSignal));
      expect(soul.create).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { instructions: '' }, { instructions: '  ' }])(
    'POST rejects missing or blank instructions (%j)',
    async (body) => {
      const { soul, mutate } = setup();
      expect((await mutate('POST', body)).status).toBe(400);
      expect(soul.create).not.toHaveBeenCalled();
    },
  );

  it.each(['POST', 'PATCH'] as const)(
    'validates %s instructions before invoking generation',
    async (method) => {
      const { soul, mutate } = setup();
      for (const body of [
        { instructions: 1 },
        { instructions: null },
        { instructions: 'x'.repeat(10_001) },
      ]) {
        expect((await mutate(method, body)).status).toBe(400);
      }
      expect(soul.create).not.toHaveBeenCalled();
      expect(soul.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['invalid_instructions', 400],
    ['soul_not_found', 404],
    ['operation_in_progress', 409],
    ['soul_changed', 409],
    ['no_chat_models', 503],
    ['generation_failed', 502],
    ['request_cancelled', 503],
  ] as const)('maps %s to HTTP %i', async (code: SoulErrorCode, status) => {
    const { soul, mutate } = setup();
    soul.create.mockRejectedValue(new SoulError(code, 'Public error'));
    soul.update.mockRejectedValue(new SoulError(code, 'Public error'));
    for (const method of ['POST', 'PATCH'] as const) {
      const response = await mutate(method);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        code,
        error: 'Public error',
      });
    }
  });

  it('does not expose filesystem or provider details on unexpected failures', async () => {
    const { soul, mutate } = setup();
    soul.create.mockRejectedValue(new Error('secret provider details'));
    const response = await mutate('POST');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret provider details');
  });
});

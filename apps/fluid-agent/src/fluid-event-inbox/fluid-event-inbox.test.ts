import { describe, expect, it } from 'vitest';

import type { FluidEvent } from '@stagewise/mcp-extension-fluid-events';

import { createInMemoryFluidEventInbox } from './fluid-event-inbox';

const event: FluidEvent = {
  eventId: 'event-1',
  sourceId: 'chat:local',
  type: 'chat.message.received',
  createdAt: '2026-07-20T10:30:00.000Z',
  payload: { message: 'hello' },
};

describe('In-memory Fluid Event inbox', () => {
  it('deduplicates events within a namespace and preserves order', async () => {
    const inbox = createInMemoryFluidEventInbox();
    const second = { ...event, eventId: 'event-2' };

    await expect(
      inbox.commit('chat', [event, second, event], 'cursor-3'),
    ).resolves.toEqual([event, second]);
    await expect(inbox.commit('chat', [event], 'cursor-4')).resolves.toEqual(
      [],
    );
    await expect(inbox.readCursor('chat')).resolves.toBe('cursor-4');
  });

  it('isolates event identifiers by namespace', async () => {
    const inbox = createInMemoryFluidEventInbox();

    await expect(inbox.commit('chat-a', [event], '1')).resolves.toEqual([
      event,
    ]);
    await expect(inbox.commit('chat-b', [event], '1')).resolves.toEqual([
      event,
    ]);
  });

  it('updates cursors for empty pages', async () => {
    const inbox = createInMemoryFluidEventInbox();

    await inbox.commit('chat', [], 'cursor-empty');
    await expect(inbox.readCursor('chat')).resolves.toBe('cursor-empty');
  });

  it('does not expose mutable stored events', async () => {
    const inbox = createInMemoryFluidEventInbox();
    const input = structuredClone(event);
    const accepted = await inbox.commit('chat', [input], '1');

    input.payload.message = 'changed input';
    if (accepted[0]) accepted[0].payload.message = 'changed result';

    await expect(inbox.commit('chat', [event], '2')).resolves.toEqual([]);
  });
});

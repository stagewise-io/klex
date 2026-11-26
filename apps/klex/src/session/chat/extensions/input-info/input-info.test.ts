import type { Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type z from 'zod';

import { createInputProjections } from '@/input-projections';

import type { ExtensionDeps } from '../extension-api';
import { createInputInfoExt } from './input-info';

describe('input detail tool scope', () => {
  const options = { toolCallId: 'test', messages: [], context: undefined };
  const input = {
    eventId: 'abcdefgh',
    reason: 'Need routing context',
    cursor: 'page',
  };
  function setup(parent?: string, allowed?: ReadonlySet<string>) {
    const projections = createInputProjections();
    const read = vi
      .spyOn(projections, 'readUnfiltered')
      .mockResolvedValue({ status: 'ok' });
    const extension = createInputInfoExt(projections, parent, allowed).create({
      sessionId: 'child',
    } as ExtensionDeps);
    const tool = extension.getTools!({} as never).getUnfilteredInput as Tool<
      typeof input
    >;
    return {
      read,
      execute: tool.execute!,
      schema: tool.inputSchema as z.ZodType,
    };
  }
  it('validates the reason and forwards owning-session pagination', async () => {
    const { read, execute, schema } = setup();
    for (const reason of [undefined, '   ', 'x'.repeat(1001)]) {
      expect(schema.safeParse({ ...input, reason }).success).toBe(false);
    }
    expect(schema.safeParse(input).success).toBe(true);
    await execute(input, options);
    expect(read).toHaveBeenCalledWith(
      'child',
      input.eventId,
      input.cursor,
      input.reason,
    );
  });
  it('restricts delegated access to an explicit reference allow-list', async () => {
    const { read, execute } = setup('parent', new Set([input.eventId]));
    expect(await execute({ ...input, eventId: 'ijklmnop' }, options)).toEqual({
      status: 'unavailable',
    });
    expect(read).not.toHaveBeenCalled();
    await execute(input, options);
    expect(read).toHaveBeenCalledWith(
      'parent',
      input.eventId,
      input.cursor,
      input.reason,
    );
  });
});

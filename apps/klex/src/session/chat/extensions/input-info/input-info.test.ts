import type { Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type z from 'zod';

import { createInputProjections } from '@/input-projections';

import type { ExtensionDeps } from '../extension-api';
import { createInputInfoExt } from './input-info';

describe('input detail tool scope', () => {
  it('requires a bounded nonblank reason in the model-facing schema', () => {
    const extension = createInputInfoExt(createInputProjections()).create({
      sessionId: 'main',
    } as ExtensionDeps);
    const schema = extension.getTools?.({} as never).getMoreInputInfo
      ?.inputSchema as z.ZodType;
    const input = { eventId: 'abcdefgh', infoSection: 'raw' };
    expect(schema.safeParse(input).success).toBe(false);
    expect(schema.safeParse({ ...input, reason: '   ' }).success).toBe(false);
    expect(
      schema.safeParse({ ...input, reason: 'x'.repeat(1001) }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...input, reason: 'Need recipient to reply' }).success,
    ).toBe(true);
  });
  it('uses the owning session by default and forwards pagination unchanged', async () => {
    const projections = createInputProjections();
    const read = vi
      .spyOn(projections, 'readSection')
      .mockResolvedValue({ status: 'unavailable' });
    const extension = createInputInfoExt(projections).create({
      sessionId: 'child',
    } as ExtensionDeps);
    if (!extension.getTools) throw new Error('Missing detail tool');
    const execute = (
      extension.getTools({} as never).getMoreInputInfo as Tool<{
        eventId: string;
        infoSection: string;
        reason: string;
        cursor?: string;
      }>
    ).execute;
    expect(execute).toBeDefined();
    await execute?.(
      {
        eventId: 'abcdefgh',
        infoSection: 'raw',
        reason: 'Need the reply destination',
        cursor: 'page',
      },
      { toolCallId: 'test', messages: [], context: undefined },
    );
    expect(read).toHaveBeenCalledWith(
      'child',
      'abcdefgh',
      'raw',
      'page',
      'Need the reply destination',
    );
  });

  it('restricts delegated access to an explicit reference allow-list', async () => {
    const projections = createInputProjections();
    const read = vi
      .spyOn(projections, 'readSection')
      .mockResolvedValue({ status: 'ok' });
    const extension = createInputInfoExt(
      projections,
      'parent',
      new Set(['abcdefgh']),
    ).create({ sessionId: 'child' } as ExtensionDeps);
    if (!extension.getTools) throw new Error('Missing detail tool');
    const execute = (
      extension.getTools({} as never).getMoreInputInfo as Tool<{
        eventId: string;
        infoSection: string;
        reason: string;
        cursor?: string;
      }>
    ).execute;
    const options = { toolCallId: 'test', messages: [], context: undefined };
    expect(
      await execute?.(
        {
          eventId: 'ijklmnop',
          infoSection: 'raw',
          reason: 'Need routing context',
        },
        options,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(read).not.toHaveBeenCalled();
    await execute?.(
      {
        eventId: 'abcdefgh',
        infoSection: 'raw',
        reason: 'Need routing context',
      },
      options,
    );
    expect(read).toHaveBeenCalledWith(
      'parent',
      'abcdefgh',
      'raw',
      undefined,
      'Need routing context',
    );
  });
});

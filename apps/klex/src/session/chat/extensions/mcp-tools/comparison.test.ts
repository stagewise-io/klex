import { existsSync, statSync } from 'node:fs';

import { getEncoding } from 'js-tiktoken';
import { expect, it } from 'vitest';

import type { Mcp } from '@/mcp';
import type { JsonObject } from '@/tool-provider';

import type { ExtensionDeps } from '../extension-api';
import { createMcpToolsExt } from './mcp-tools';

it('records scripted direct-call costs, not live model quality or inference latency', async () => {
  const encode = getEncoding('o200k_base');
  const records = Array.from({ length: 1000 }, (_, id) => ({
    id,
    value: 'payload'.repeat(12),
  }));
  const provider = {
    invoke: async (ref: { name: string }, input: JsonObject) =>
      ref.name === 'large' ? records : input,
    releaseToolSession: () => undefined,
  };
  const before = process.memoryUsage().rss;
  const start = performance.now();
  const extension = createMcpToolsExt.create({
    mcp: provider as unknown as Mcp,
    sessionId: 'bench',
  } as ExtensionDeps);
  const tools = extension.getTools!({} as never)!;
  const startupMs = performance.now() - start;
  const rssDeltaBytes = process.memoryUsage().rss - before;
  const call = async (toolName: string, params: JsonObject) => {
    const input = { mcpServer: 'bench', toolName, params };
    const started = performance.now();
    const result = await tools.runTool!.execute!(input, {
      toolCallId: 'bench',
      messages: [],
      context: undefined,
    });
    const dispatchMs = performance.now() - started;
    return {
      result,
      dispatchMs,
      tokens:
        encode.encode(JSON.stringify(input)).length +
        encode.encode(JSON.stringify(result)).length,
    };
  };
  const single = await call('echo', { value: 1 });
  console.info('direct scripted single', {
    dispatchMs: single.dispatchMs,
    tokens: single.tokens,
    modelToolRoundTrips: 1,
  });
  expect(single.result).toEqual({ value: 1 });
  const first = await call('echo', { value: 1 });
  const second = await call('echo', {
    value: (first.result as { value: number }).value + 1,
  });
  console.info('direct scripted chain', {
    dispatchMs: first.dispatchMs + second.dispatchMs,
    tokens: first.tokens + second.tokens,
    modelToolRoundTrips: 2,
  });
  expect(second.result).toEqual({ value: 2 });
  const large = await call('large', {});
  console.info('direct scripted large', {
    dispatchMs: large.dispatchMs,
    tokens: large.tokens,
    modelToolRoundTrips: 1,
    note: '1000 rows exposed; no hidden local filtering',
  });
  expect(large.result).toHaveLength(1000);
  console.info('direct baseline', {
    startupMs,
    rssDeltaBytes,
    binaryBytes: existsSync('dist/klex') ? statSync('dist/klex').size : null,
  });
  await extension.onClose!();
});

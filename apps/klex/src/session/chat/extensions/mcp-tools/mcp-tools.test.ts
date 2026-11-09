import { asSchema, type Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { Mcp } from '@/mcp';
import { testLogger } from '@/session/chat/test-helpers';
import type { PreparedInferenceContext } from '@/session/interaction';
import { ToolExecutor } from '@/session/interaction/tool-executor';
import { buildGPTLiveSessionConfig } from '@/session/realtime/gpt-live/session-config';
import { toSessionTools } from '@/session/realtime/openai-realtime/conversation-items';
import { ToolGatewayError } from '@/tool-provider';

import type { ExtensionDeps } from '../extension-api';
import { createMcpToolsExt } from './mcp-tools';

function setup() {
  const provider = {
    invoke: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: true,
    }),
    listTools: vi.fn(),
    getToolInfo: vi.fn(),
    releaseToolSession: vi.fn(),
  };
  const extension = createMcpToolsExt.create({
    mcp: provider as unknown as Mcp,
    sessionId: 'session',
  } as ExtensionDeps);
  return {
    provider,
    extension,
    tools: extension.getTools!(
      {} as Parameters<NonNullable<typeof extension.getTools>>[0],
    ) as Record<string, Tool>,
  };
}

async function call(tool: Tool, input: unknown, abortSignal?: AbortSignal) {
  return tool.execute!(input, {
    toolCallId: 'execution',
    messages: [],
    context: undefined,
    abortSignal,
  });
}

describe('direct MCP extension', () => {
  it('requires explicit MCP access', () => {
    expect(() =>
      createMcpToolsExt.create({ sessionId: 'isolated' } as ExtensionDeps),
    ).toThrow('requires MCP');
  });

  it('exposes exactly three tools and preserves request context and MCP content/error flags', async () => {
    const { tools, provider } = setup();
    expect(Object.keys(tools)).toEqual(['runTool', 'listTools', 'getToolInfo']);
    const params = { nested: { a: [null, true, 2, 'x'] } };
    expect(
      await call(tools.runTool!, { mcpServer: 's', toolName: 't', params }),
    ).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: true });
    expect(provider.invoke).toHaveBeenCalledWith(
      { namespace: 's', name: 't' },
      params,
      expect.objectContaining({
        executionId: 'execution',
        sessionId: 'session',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('serializes a generic params schema for model adapters and validates it', async () => {
    const { tools } = setup();
    const schema = asSchema(tools.runTool!.inputSchema);
    expect(await schema.jsonSchema).toMatchObject({
      type: 'object',
      properties: { params: { type: 'object' } },
    });
    expect(
      (
        await schema.validate!({
          mcpServer: 's',
          toolName: 't',
          params: { array: [1, false, null] },
        })
      ).success,
    ).toBe(true);
    expect(
      (await schema.validate!({ mcpServer: 's', toolName: 't', params: [] }))
        .success,
    ).toBe(false);
  });

  it('retains generic params in GPT-Live and OpenAI realtime declarations', async () => {
    const { tools } = setup();
    const descriptors = await Promise.all(
      Object.entries(tools).map(async ([name, tool]) => ({
        name,
        description:
          typeof tool.description === 'string' ? tool.description : undefined,
        inputSchema: { ...(await asSchema(tool.inputSchema).jsonSchema) },
      })),
    );
    const context = {
      instructions: 'test',
      messages: [],
      tools: descriptors,
    } as unknown as PreparedInferenceContext;
    const gpt = buildGPTLiveSessionConfig(context, {
      responsesModel: 'test',
      frontendInstructions: 'test',
    });
    for (const declarations of [
      toSessionTools(descriptors),
      gpt.session.delegation.responses.tools,
    ]) {
      expect(declarations.map((tool) => tool.name)).toEqual([
        'runTool',
        'listTools',
        'getToolInfo',
      ]);
      expect(declarations[0]!.parameters).toEqual(descriptors[0]!.inputSchema);
      expect(declarations[0]!.parameters).toMatchObject({
        properties: { params: { type: 'object' } },
      });
    }
  });

  it('returns safe structured local errors and hides transport exceptions', async () => {
    const { tools, provider } = setup();
    provider.invoke.mockRejectedValueOnce(
      new ToolGatewayError('invalid-params', 'Inspect getToolInfo.', [
        { path: '/a', keyword: 'type' },
      ]),
    );
    expect(
      await call(tools.runTool!, { mcpServer: 's', toolName: 't', params: {} }),
    ).toMatchObject({
      isError: true,
      error: {
        code: 'invalid-params',
        issues: [{ path: '/a', keyword: 'type' }],
      },
    });
    provider.invoke.mockRejectedValueOnce(new Error('secret transport data'));
    expect(
      JSON.stringify(
        await call(tools.runTool!, {
          mcpServer: 's',
          toolName: 't',
          params: {},
        }),
      ),
    ).not.toContain('secret');
  });

  it('passes native text execution, deduplicates IDs and cancels in-flight calls on close', async () => {
    const { tools, provider, extension } = setup();
    const executor = new ToolExecutor({
      logger: testLogger,
      tools,
      modelMessages: [],
      sessionId: 'session',
      validateInput: true,
      timeoutMs: 100,
    });
    const request = {
      executionId: 'same',
      name: 'runTool',
      input: {
        mcpServer: 's',
        toolName: 't',
        params: { nested: [1, true, null] },
      },
    };
    await Promise.all([executor.execute(request), executor.execute(request)]);
    expect(provider.invoke).toHaveBeenCalledTimes(1);
    provider.invoke.mockImplementationOnce(
      (_ref, _input, context) =>
        new Promise((_resolve, reject) =>
          context.signal.addEventListener(
            'abort',
            () => reject(new Error('closed')),
            { once: true },
          ),
        ),
    );
    const pending = call(tools.runTool!, {
      mcpServer: 's',
      toolName: 't',
      params: {},
    });
    await extension.onClose!();
    expect(await pending).toMatchObject({
      isError: true,
      error: { code: 'cancelled' },
    });
    expect(provider.invoke).toHaveBeenCalledTimes(2);
  });

  it('propagates executor timeout without replay', async () => {
    const { tools, provider } = setup();
    provider.invoke.mockImplementationOnce(
      (_ref, _input, context) =>
        new Promise((_resolve, reject) =>
          context.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          ),
        ),
    );
    const executor = new ToolExecutor({
      logger: testLogger,
      tools,
      modelMessages: [],
      sessionId: 'session',
      validateInput: true,
      timeoutMs: 5,
    });
    const result = await executor.execute({
      executionId: 'timeout',
      name: 'runTool',
      input: { mcpServer: 's', toolName: 't', params: {} },
    });
    expect(JSON.stringify(result)).toContain('timeout');
    expect(provider.invoke).toHaveBeenCalledTimes(1);
  });

  it('prevents post-close dispatch and releases only owned session cursors', async () => {
    const { tools, provider, extension } = setup();
    await extension.onClose!();
    expect(provider.releaseToolSession).toHaveBeenCalledWith('session');
    expect(
      await call(tools.runTool!, { mcpServer: 's', toolName: 't', params: {} }),
    ).toMatchObject({ error: { code: 'cancelled' } });
    expect(provider.invoke).not.toHaveBeenCalled();
  });
});

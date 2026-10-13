import type { ToolSet } from 'ai';
import { vi } from 'vitest';

import type { ExtensionDeps } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { ChildSessionHandle, ChildSessionOptions } from '@/session/types';

export interface ChildTask {
  system: string;
  prompt: string;
  tools: ToolSet;
  abortSignal: AbortSignal;
}

export interface ChildReply {
  text: string;
  submit: boolean;
}

export function reply(text = '{"operations": []}'): ChildReply {
  return { text, submit: true };
}

export async function submitFixture(
  task: ChildTask,
  text: string,
): Promise<unknown> {
  const execute = task.tools.submitLearnings?.execute;
  if (!execute) throw new Error('Submission tool missing');
  return execute(JSON.parse(text), {
    toolCallId: 'fixture-submit',
    messages: [],
    context: undefined,
    abortSignal: task.abortSignal,
  });
}

/** Simulates delivery and idle only. Tests execute the real learning tools. */
export function childHarness() {
  const runChild = vi.fn<(task: ChildTask) => Promise<ChildReply>>(async () =>
    reply(),
  );
  const children: ChildSessionHandle[] = [];
  const createChildSession = vi.fn<ExtensionDeps['createChildSession']>(
    async (options: ChildSessionOptions) => {
      const controller = new AbortController();
      const extensions = options.extensions.map((factory) =>
        factory.create({} as ExtensionDeps),
      );
      const tools = Object.assign(
        {},
        ...extensions.map((extension) =>
          extension.getTools?.({
            modelId: 'test:model',
            contextSize: 32_000,
            inputCapabilities: {},
          }),
        ),
      ) as ToolSet;
      let settled = false;
      let terminated = false;
      let work: Promise<void> = Promise.resolve();
      const child = {
        sessionId: `child-${children.length}`,
        inbox: {
          sendMessage: vi.fn((message: ExtendedUIMessage) => {
            const prompt = message.parts
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n');
            const task = {
              system: options.basePrompt,
              prompt,
              tools,
              abortSignal: controller.signal,
            };
            work = (async () => {
              try {
                const result = await runChild(task);
                if (result.submit && !controller.signal.aborted)
                  await submitFixture(task, result.text);
              } catch (error) {
                if (error instanceof Error && error.name === 'AssertionError')
                  throw error;
                terminated = true;
              } finally {
                settled = true;
              }
            })();
          }),
        },
        getSessionInfo: () => ({
          status: terminated ? 'terminated' : 'active',
        }),
        waitForIdle: vi.fn(async () => {
          await work;
          return true;
        }),
        close: vi.fn(async () => {
          controller.abort();
          await work;
          terminated = true;
        }),
        isQuiescent: () => settled,
      } as unknown as ChildSessionHandle;
      children.push(child);
      return child;
    },
  );
  return { runChild, createChildSession, children };
}

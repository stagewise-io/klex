import type { InferUITools, ToolSet } from 'ai';
import type { getReplSandboxTools } from './js-repl-sandbox';
import type { getMemoryTools } from './memory';

export type AgentTools = ReturnType<typeof getMemoryTools> &
  ReturnType<typeof getReplSandboxTools>;

export type AgentUITools = InferUITools<AgentTools>;

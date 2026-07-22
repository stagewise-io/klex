import type { InferUITools } from 'ai';

import type { JavaScriptTool } from './javascript';
import type { getMemoryTools } from './memory';

export type AgentTools = ReturnType<typeof getMemoryTools> &
  JavaScriptTool['tools'];

export type AgentUITools = InferUITools<AgentTools>;

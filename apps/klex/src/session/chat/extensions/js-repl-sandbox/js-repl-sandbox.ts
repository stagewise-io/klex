import type { ToolSet } from 'ai';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  ResolvedModel,
} from '../extension-api';
import { createJavaScriptTool, type JavaScriptTool } from './javascript';
import systemPromptPart from './system-prompt-part.md';

class JsReplSandboxExt implements Extension {
  private readonly javaScriptTool: JavaScriptTool;

  constructor(deps: ExtensionDeps) {
    if (!deps.mcp) {
      throw new Error(
        'js-repl-sandbox extension requires MCP access — cannot be loaded in sessions without MCP',
      );
    }
    this.javaScriptTool = createJavaScriptTool({
      logging: deps.logging,
      provider: deps.mcp,
    });
    this.javaScriptTool.sessionId = deps.sessionId;
  }

  async onStart(): Promise<void> {
    await this.javaScriptTool.start();
  }

  async onClose(): Promise<void> {
    await this.javaScriptTool.close();
  }

  getTools(_model: ResolvedModel): ToolSet {
    return this.javaScriptTool.tools;
  }

  getSystemPromptPart(): string {
    return systemPromptPart;
  }
}

/** Adds a session-scoped JavaScript sandbox and exposes its execution tool. */
export const createJsReplSandboxExt: ExtensionFactory = {
  identifier: 'io.stagewise/js-repl-sandbox',
  displayName: 'JS REPL Sandbox',
  create: (deps) => new JsReplSandboxExt(deps),
};

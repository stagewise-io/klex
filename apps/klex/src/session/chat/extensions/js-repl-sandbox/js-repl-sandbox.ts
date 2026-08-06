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

export const createJsReplSandboxExt: ExtensionFactory = {
  identifier: 'io.stagewise/js-repl-sandbox',
  displayName: 'JS REPL Sandbox',
  create: (deps) => new JsReplSandboxExt(deps),
};

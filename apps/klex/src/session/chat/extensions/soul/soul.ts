import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ToolSet, tool } from 'ai';
import z from 'zod';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  ResolvedModel,
} from '../extension-api';
import noSoulPrompt from './no-soul-prompt.md';

/**
 * File name of the soul definition inside the extension's global data
 * directory.
 */
const SOUL_FILE = 'SOUL.md';

/**
 * Maximum allowed length for soul content, in characters. Enforced both
 * in the tool's input schema and documented in the no-soul prompt.
 */
const MAX_SOUL_LENGTH = 10_000;

class SoulExt implements Extension {
  /** Absolute path to the global extension data directory. */
  private readonly soulDir: string;

  /** Absolute path to `SOUL.md` inside {@link soulDir}. */
  private readonly soulPath: string;

  constructor(deps: ExtensionDeps) {
    this.soulDir = deps.getDataDir(true);
    this.soulPath = join(this.soulDir, SOUL_FILE);
  }

  /**
   * Returns the soul content for the system prompt. If `SOUL.md` exists
   * in the global extension directory, its contents are returned verbatim.
   * Otherwise the no-soul prompt is returned, which instructs the model
   * to build its soul together with the user.
   *
   * Called once per step. Re-reads the file each time so manual edits
   * are picked up without restarting the session.
   */
  getSystemPromptPart(): string {
    if (existsSync(this.soulPath)) {
      const content = readFileSync(this.soulPath, 'utf-8');
      if (content.trim().length > 0) return content;
    }
    return noSoulPrompt;
  }

  /**
   * Provides the `createSoul` tool — but only when no soul exists yet.
   * Once `SOUL.md` has been written, the tool is no longer offered to
   * the model.
   */
  getTools(_model: ResolvedModel): ToolSet {
    if (existsSync(this.soulPath)) return {};

    return {
      createSoul: tool({
        description:
          'Save and activate your soul. Call this only once, after you and the user have agreed on the final soul content. The content must be at most 10000 characters and must contain your name, personality, how you respond, and your life purpose. Once saved, your soul is permanent and this tool will no longer be available.',
        inputSchema: z.object({
          content: z
            .string()
            .min(1)
            .max(MAX_SOUL_LENGTH)
            .describe(
              'The full soul text, written in short terse sentences. Must contain your name, personality, response style, and life purpose.',
            ),
        }),
        execute: async ({ content }) => {
          // Guard against a race where the soul was created between
          // getTools() and this execution (e.g. manual file creation
          // or a duplicate tool call in the same step).
          if (existsSync(this.soulPath)) {
            return 'A soul already exists. Your soul is already saved and active.';
          }

          mkdirSync(this.soulDir, { recursive: true });
          writeFileSync(this.soulPath, content, 'utf-8');

          return 'Your soul has been saved and activated. You are now who you are.';
        },
      }),
    };
  }

  introspect(): Record<string, unknown> {
    return {
      hasSoul: existsSync(this.soulPath),
      soulPath: this.soulPath,
    };
  }
}

export const createSoulExt: ExtensionFactory = {
  identifier: 'io.stagewise/soul',
  displayName: 'Soul',
  create: (deps) => new SoulExt(deps),
};

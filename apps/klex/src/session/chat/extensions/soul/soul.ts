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
import noSoulPromptRegular from './no-soul-prompt-regular.md';
import updateSoulToolDescription from './update-soul-tool-description.md';

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

/**
 * The mode of a soul extension instance.
 *
 * - `'standard'` — used in regular (router) sessions. The extension is
 *   read-only: it injects the soul content (or a confused rejection
 *   prompt when no soul exists) into the system prompt but provides no
 *   tools. The soul cannot be created or updated from a regular session.
 * - `'god'` — used in the dedicated god-message session. The extension
 *   provides `updateSoul`, allowing the agent to define or rewrite its soul
 *   when explicitly instructed by a god message.
 */
type SoulMode = 'standard' | 'god';

class SoulExt implements Extension {
  /** Absolute path to the global extension data directory. */
  private readonly soulDir: string;

  /** Absolute path to `SOUL.md` inside {@link soulDir}. */
  private readonly soulPath: string;

  constructor(
    deps: ExtensionDeps,
    private readonly mode: SoulMode = 'standard',
  ) {
    this.soulDir = deps.getDataDir(true);
    this.soulPath = join(this.soulDir, SOUL_FILE);
  }

  /**
   * Reads and returns the soul content if `SOUL.md` exists and is
   * non-empty after trimming. Returns `null` otherwise. All soul-state
   * checks (prompt, tools, execute guard, introspection) go through
   * this method so they stay consistent.
   */
  private readSoul(): string | null {
    if (!existsSync(this.soulPath)) return null;
    const content = readFileSync(this.soulPath, 'utf-8');
    if (content.trim().length === 0) return null;
    return content;
  }

  private soulContentSchema() {
    return z
      .string()
      .min(1)
      .refine((content) => content.trim().length > 0, {
        message: 'Soul content must not be blank',
      })
      .max(MAX_SOUL_LENGTH);
  }

  /**
   * Returns the soul content for the system prompt. If `SOUL.md` exists
   * in the global extension directory, its contents are returned verbatim.
   * Otherwise the mode-appropriate no-soul prompt is returned:
   *
   * - `'god'` mode → the aggressive soul-building prompt that instructs
   *   the model to build its soul (obeying god messages that command
   *   immediate creation).
   * - `'standard'` mode → a confused rejection prompt. The agent does
   *   not know who it is and refuses to function.
   *
   * Called once per step. Re-reads the file each time so manual edits
   * are picked up without restarting the session.
   */
  getSystemPromptPart(): string {
    const soul = this.readSoul();
    if (soul !== null) return soul;
    return this.mode === 'god' ? noSoulPrompt : noSoulPromptRegular;
  }

  /**
   * Provides soul tools — but only in god mode.
   *
   * - `'standard'` mode → always returns `{}` (no tools). Regular
   *   sessions cannot create or update the soul.
   * - `'god'` mode → always provides `updateSoul`.
   */
  getTools(_model: ResolvedModel): ToolSet {
    if (this.mode === 'standard') return {};

    return {
      updateSoul: tool({
        description: updateSoulToolDescription,
        inputSchema: z.object({
          content: this.soulContentSchema(),
        }),
        execute: async ({ content }) => {
          mkdirSync(this.soulDir, { recursive: true });
          writeFileSync(this.soulPath, content, 'utf-8');

          return 'Your soul has been updated.';
        },
      }),
    };
  }

  introspect(): Record<string, unknown> {
    return {
      hasSoul: this.readSoul() !== null,
      soulPath: this.soulPath,
      mode: this.mode,
    };
  }
}

export const createSoulExt: ExtensionFactory = {
  identifier: 'io.stagewise/soul',
  displayName: 'Soul',
  create: (deps) => new SoulExt(deps, 'standard'),
};

export const createSoulExtGod: ExtensionFactory = {
  identifier: 'io.stagewise/soul',
  displayName: 'Soul (God)',
  create: (deps) => new SoulExt(deps, 'god'),
};

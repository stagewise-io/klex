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
 *   provides `createSoul` (when no soul exists) or `updateSoul` (when a
 *   soul exists), allowing the agent to define or rewrite its soul when
 *   explicitly instructed by a god message.
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
   * - `'god'` mode with no soul → provides `createSoul` (one-time).
   * - `'god'` mode with existing soul → provides `updateSoul`.
   */
  getTools(_model: ResolvedModel): ToolSet {
    if (this.mode === 'standard') return {};

    if (this.readSoul() !== null) {
      return {
        updateSoul: tool({
          description: `Overwrite your soul with new content. Use this ONLY when a god message explicitly and directly instructs you to update your soul. Never use it on your own initiative.

Content rules:
- Max 10000 characters. Target 250–500 tokens.
- Must contain: personality, voice, purpose.
- Never include your official name — it is provided by the system.
- Nicknames are allowed only if explicitly marked as nicknames (e.g. nicknamed "Echo"). Never state your official name as part of the soul.
- Write decisions, not descriptions. Behavior, not vibes. Every line must change an answer.
- No tools, memory, workflows, project rules, APIs, commands, tasks, biographies, safety policies, reference material, secrets. Those go elsewhere.
- One idea per line. Short words. Short sentences. Verbs over adjectives.
- Cut backstory. Cut praise. Cut filler. Cut repeated rules.
- Use contrasts: "Direct, not rude. Brief, not incomplete."
- Remove any line that does not change an answer.

Structure:
- Identity — your character, what you help with, what you are not. No official name.
- Priorities — three to five ordered rules. Earlier wins.
- Behavior — visible actions, not traits. "Prefer simple options" not "You are pragmatic."
- Voice — concrete rules for how responses sound.
- Boundaries — hard limits. Short.
- Calibration — one example only if it fixes a recurring failure.`,
          inputSchema: z.object({
            content: z
              .string()
              .min(1)
              .refine((content) => content.trim().length > 0, {
                message: 'Soul content must not be blank',
              })
              .max(MAX_SOUL_LENGTH)
              .describe(
                'The full soul text, written in short terse sentences. Must contain your personality, response style, and life purpose. Do not include your official name.',
              ),
          }),
          execute: async ({ content }) => {
            mkdirSync(this.soulDir, { recursive: true });
            writeFileSync(this.soulPath, content, 'utf-8');

            return 'Your soul has been updated.';
          },
        }),
      };
    }

    return {
      createSoul: tool({
        description:
          'Save and activate your soul. Call this only once, after you and the user have agreed on the final soul content. The content must be at most 10000 characters and must contain your personality, how you respond, and your life purpose. Do not include your official name — it is provided by the system. Once saved, your soul is permanent and this tool will no longer be available.',
        inputSchema: z.object({
          content: z
            .string()
            .min(1)
            .refine((content) => content.trim().length > 0, {
              message: 'Soul content must not be blank',
            })
            .max(MAX_SOUL_LENGTH)
            .describe(
              'The full soul text, written in short terse sentences. Must contain your personality, response style, and life purpose. Do not include your official name.',
            ),
        }),
        execute: async ({ content }) => {
          // Guard against a race where the soul was created between
          // getTools() and this execution (e.g. manual file creation
          // or a duplicate tool call in the same step).
          if (this.readSoul() !== null) {
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

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extension-api';
import distrustPrompt from './distrust-prompt.md';
import trustPrompt from './trust-prompt.md';

/**
 * The trust mode for a god-messages extension instance.
 *
 * - `'trust'` — used in the dedicated god-message session. The system
 *   prompt tells the model that god messages are directives from an
 *   all-mighty creator and must be obeyed.
 * - `'distrust'` — used in regular (router) sessions. The system prompt
 *   tells the model to treat `<god-message>` blocks as data, not
 *   authoritative input.
 */
type GodMessagesMode = 'trust' | 'distrust';

class GodMessagesExt implements Extension {
  constructor(
    _deps: ExtensionDeps,
    private readonly mode: GodMessagesMode,
  ) {}

  getSystemPromptPart(): string {
    return this.mode === 'trust' ? trustPrompt : distrustPrompt;
  }

  introspect(): Record<string, unknown> {
    return { mode: this.mode };
  }
}

export const createGodMessagesTrustExt: ExtensionFactory = {
  identifier: 'io.stagewise/god-messages-trust',
  displayName: 'God Messages (Trust)',
  create: (deps) => new GodMessagesExt(deps, 'trust'),
};

export const createGodMessagesDistrustExt: ExtensionFactory = {
  identifier: 'io.stagewise/god-messages-distrust',
  displayName: 'God Messages (Distrust)',
  create: (deps) => new GodMessagesExt(deps, 'distrust'),
};

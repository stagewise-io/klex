import type { Extension, ExtensionFactory } from '../extension-api';

export interface VoiceCapabilityExtConfig {
  /**
   * Whether a voice conversation model resolves right now. Read once per
   * step, so adding or removing a voice model applies to the next step.
   */
  hasVoiceModel: () => boolean;
}

const NO_VOICE_MODEL_PROMPT = `## Voice calls

You have no voice conversation model right now, so you cannot take calls, join voice channels or talk live. When someone asks for that, do not try. Ask them to configure and connect a voice conversation model first.`;

class VoiceCapabilityExt implements Extension {
  constructor(private readonly config: VoiceCapabilityExtConfig) {}

  getSystemPromptPart(): string {
    return this.config.hasVoiceModel() ? '' : NO_VOICE_MODEL_PROMPT;
  }

  introspect(): Record<string, unknown> {
    return { hasVoiceModel: this.config.hasVoiceModel() };
  }
}

/**
 * Tells the bot when it cannot take voice calls, so it explains the missing
 * voice model instead of promising a call that its runtime would reject.
 */
export function createVoiceCapabilityExt(
  config: VoiceCapabilityExtConfig,
): ExtensionFactory {
  return {
    identifier: 'io.stagewise/voice-capability',
    displayName: 'Voice Capability',
    create: () => new VoiceCapabilityExt(config),
  };
}

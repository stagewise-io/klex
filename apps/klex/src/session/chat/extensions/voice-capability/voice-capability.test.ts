import { describe, expect, it } from 'vitest';

import type { ExtensionDeps } from '../extension-api';
import { createVoiceCapabilityExt } from './voice-capability';

const deps = {} as ExtensionDeps;

describe('VoiceCapabilityExt — getSystemPromptPart', () => {
  it('tells the bot to ask for a voice model while none resolves', () => {
    const ext = createVoiceCapabilityExt({ hasVoiceModel: () => false }).create(
      deps,
    );
    const part = ext.getSystemPromptPart?.();
    expect(part).toContain('cannot take calls, join voice channels');
    expect(part).toContain('voice conversation model must first be added');
  });

  it('adds nothing once a voice model resolves', () => {
    const ext = createVoiceCapabilityExt({ hasVoiceModel: () => true }).create(
      deps,
    );
    expect(ext.getSystemPromptPart?.()).toBe('');
  });

  it('follows a voice model added during the session', () => {
    let hasVoiceModel = false;
    const ext = createVoiceCapabilityExt({
      hasVoiceModel: () => hasVoiceModel,
    }).create(deps);
    expect(ext.getSystemPromptPart?.()).not.toBe('');
    hasVoiceModel = true;
    expect(ext.getSystemPromptPart?.()).toBe('');
  });
});

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
    expect(part).toContain('configure and connect a voice conversation model');
  });

  it('does not tell the user where to add the voice model', () => {
    const ext = createVoiceCapabilityExt({ hasVoiceModel: () => false }).create(
      deps,
    );
    expect(ext.getSystemPromptPart?.()).not.toContain('Klex Cloud');
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

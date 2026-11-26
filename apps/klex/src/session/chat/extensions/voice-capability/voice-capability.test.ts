import { describe, expect, it } from 'vitest';

import type { ExtensionDeps } from '../extension-api';
import { createVoiceCapabilityExt } from './voice-capability';

const deps = {} as ExtensionDeps;

describe('VoiceCapabilityExt — getSystemPromptPart', () => {
  it('adds guidance while no voice model resolves', () => {
    const ext = createVoiceCapabilityExt({ hasVoiceModel: () => false }).create(
      deps,
    );
    const part = ext.getSystemPromptPart?.();
    expect(part).toEqual(expect.any(String));
    expect(part).not.toBe('');
  });

  it('treats a voice model that fails to resolve as missing', () => {
    const ext = createVoiceCapabilityExt({
      hasVoiceModel: () => {
        throw new Error('Realtime OpenAI provider requires an API key');
      },
    }).create(deps);
    expect(ext.getSystemPromptPart?.()).not.toBe('');
    expect(ext.introspect?.()).toEqual({ hasVoiceModel: false });
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

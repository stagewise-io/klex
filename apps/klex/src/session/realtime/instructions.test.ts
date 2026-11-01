import { describe, expect, it } from 'vitest';

import basePrompt from '@/session/chat/utils/system-prompt.md';
import { assembleInferenceInstructions } from '@/session/interaction/inference-context';

import { assembleRealtimeInstructions } from './instructions';

describe('assembleRealtimeInstructions', () => {
  it('appends live-call visibility and messaging rules after the shared instructions', () => {
    const baseInstructions = assembleInferenceInstructions(basePrompt, [
      'extension policy',
    ]);
    const instructions = assembleRealtimeInstructions(baseInstructions);

    expect(instructions).toContain(`${baseInstructions}\n\n## Live voice call`);
    expect(instructions).toContain('caller hears spoken output directly');
    expect(instructions).toContain('answers prepared by delegated models');
    expect(instructions).toContain('acknowledge and answer caller by voice');
    expect(instructions).toContain(
      'text-turn MCP reply and acknowledgement rules do not apply to spoken turns',
    );
    expect(instructions).toContain(
      'NEVER send duplicate chat/MCP messages just to acknowledge or repeat a spoken answer',
    );
    expect(instructions).toContain(
      'only send chat/MCP messages when caller explicitly asks',
    );
    expect(instructions).toContain('"send me that link in chat"');
    expect(instructions).toContain('"post this in Slack"');
    expect(instructions).toContain(
      'messaging another channel/person is the requested action',
    );
    expect(baseInstructions).not.toContain('## Live voice call');
  });

  it('includes the live-call policy even without base instructions', () => {
    expect(assembleRealtimeInstructions('   ')).toMatch(/^## Live voice call/);
  });
});

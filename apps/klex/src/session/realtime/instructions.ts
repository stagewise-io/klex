import { assembleInferenceInstructions } from '@/session/interaction/inference-context';

const VOICE_INSTRUCTIONS = `## Live voice call

- this is a live voice/phone call. caller hears spoken output directly, including answers prepared by delegated models.
- acknowledge and answer caller by voice. text-turn MCP reply and acknowledgement rules do not apply to spoken turns.
- NEVER send duplicate chat/MCP messages just to acknowledge or repeat a spoken answer.
- only send chat/MCP messages when caller explicitly asks to post/send in chat (e.g. "send me that link in chat", "post this in Slack"), or messaging another channel/person is the requested action.`;

export function assembleRealtimeInstructions(baseInstructions: string): string {
  return assembleInferenceInstructions(baseInstructions, [VOICE_INSTRUCTIONS]);
}

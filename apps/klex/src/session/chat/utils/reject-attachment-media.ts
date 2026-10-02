import type { ModelMessage } from 'ai';
import { APICallError, getToolName, isToolUIPart } from 'ai';

import type { ExtendedUIMessage } from '../message-types';

/** Retry once as text when a provider rejects attachment-bearing input before
 * tool side effects. Persist only the sanitized tool failure, never bytes. */
export function rejectAttachmentMedia(
  modelMessages: ModelMessage[],
  history: ExtendedUIMessage[],
  error: unknown,
): boolean {
  // Only explicit provider input rejections justify destroying media context.
  // Authentication, quota, transport and server errors use normal fallback.
  if (
    !APICallError.isInstance(error) ||
    ![400, 422].includes(error.statusCode ?? 0) ||
    !/(?:invalid|unsupported|malformed|cannot decode|could not decode|unable to decode)\s+(?:input\s+)?image|image\s+(?:input\s+)?(?:is\s+)?(?:invalid|unsupported|malformed|not supported)|does not support\s+(?:image|vision)/i.test(
      error.message,
    )
  )
    return false;
  const rejected = new Set<string>();
  const failure = {
    ok: false,
    error: {
      code: 'provider-error',
      message: 'Attachment unavailable: provider-error.',
    },
  };
  for (const message of modelMessages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (
        part.type !== 'tool-result' ||
        part.toolName !== 'readAttachment' ||
        part.output.type !== 'content' ||
        !part.output.value.some((item) => item.type === 'image-data')
      )
        continue;
      rejected.add(part.toolCallId);
      part.output = { type: 'json', value: failure };
    }
  }
  for (const message of history) {
    for (const part of message.parts) {
      if (
        isToolUIPart(part) &&
        getToolName(part) === 'readAttachment' &&
        rejected.has(part.toolCallId) &&
        part.state === 'output-available'
      )
        part.output = failure;
    }
  }
  return rejected.size > 0;
}

import type { ContextDataUIPart, SessionInboxEvent } from '@/session/inbox';

/**
 * Renders a canonical inbox event as a single plain-text block for
 * interaction modes that can only accept text input.
 *
 * The framing mirrors the chat path's `data-context` materialization
 * (`<context source-env=...><metadata>...</metadata><content>...`), so a
 * notification reads the same way whether the model sees it through chat
 * generation or through a realtime conversation item.
 *
 * Binary content (image/audio blobs) is reduced to a descriptive
 * placeholder: realtime text items cannot carry it, and inlining base64
 * payloads would corrupt the conversation.
 */
export function renderInteractionUpdateText(event: SessionInboxEvent): string {
  const context = event.context;
  const metadata = escapeXmlText(JSON.stringify(context.metadata));
  return [
    `<context source-env="${escapeXmlAttr(context.sourceEnv)}">`,
    `<metadata>${metadata}</metadata>`,
    `<content>${renderContent(context.content)}</content>`,
    '</context>',
  ].join('');
}

function renderContent(content: ContextDataUIPart['content']): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return escapeXmlText(block.text);
        case 'image':
        case 'audio':
          return `[${block.type} attachment: ${escapeXmlText(block.mimeType)}]`;
        case 'resource_link':
          return `[resource link: ${escapeXmlText(block.title ?? block.name)} (${escapeXmlText(block.uri)})]`;
        case 'resource':
          return block.resource.text !== undefined
            ? escapeXmlText(block.resource.text)
            : `[resource: ${escapeXmlText(block.resource.uri)}]`;
        default:
          return '';
      }
    })
    .join('\n');
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

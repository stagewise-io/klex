import type { FilePart, TextPart } from 'ai';

import {
  buildResourceAttrs,
  type ContextDataContent,
  isImageMime,
  MAX_RESOURCE_TEXT_CHARS,
  type ResourceDiffResult,
  type ResourceHandler,
  type ResourceSnapshot,
  type ResourceStateData,
  renderFullContent,
  truncate,
} from './helpers';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const imageHandler: ResourceHandler = {
  matches(mimeType) {
    return isImageMime(mimeType);
  },

  diff(_, new_) {
    // Images always get full replacement — no incremental diff.
    return {
      kind: 'full',
      reason: 'significant-change',
      content: formatImageContent(new_),
    };
  },

  formatInitialContent(snapshot) {
    return formatImageContent(snapshot);
  },

  render(data) {
    return renderImage(data);
  },
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatImageContent(snapshot: ResourceSnapshot): ContextDataContent[] {
  const blocks: ContextDataContent[] = [];
  for (const c of snapshot.contents.contents) {
    if ('blob' in c && c.blob) {
      blocks.push({
        type: 'image',
        mimeType: c.mimeType ?? snapshot.mimeType ?? 'image/png',
        data: c.blob,
      });
    } else if ('text' in c && c.text) {
      // Fallback: image stored as text (rare)
      blocks.push({
        type: 'text',
        text: truncate(c.text, MAX_RESOURCE_TEXT_CHARS),
      });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Render: full content as <resource> blocks (image as file parts)
// ---------------------------------------------------------------------------

function renderImage(data: ResourceStateData): (TextPart | FilePart)[] {
  const attrs = buildResourceAttrs(data);
  return renderFullContent(attrs, data.diff.content, data.isInitial);
}

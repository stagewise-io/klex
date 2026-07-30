import type { TextPart } from 'ai';

import type { ContextDataUIPart } from '@/session/inbox';

import type {
  DataPartTransformers,
  Extension,
  ExtensionFactory,
} from '../extension-api';

/**
 * Registers data-part transformers for the built-in custom data part
 * types (`data-context` and `data-continue`) that are core to the chat
 * session but not owned by any feature-specific extension.
 *
 * `data-context` parts originate from MCP server context events; their
 * transformer renders them as `<context>` XML for the model.
 * `data-continue` parts are injected by the turn handler to signal
 * continuation; their transformer renders them as the text "Continue.".
 */
class CoreDataPartsExt implements Extension {
  readonly identifier = 'io.stagewise/core-data-parts';
  readonly displayName = 'Core Data Parts';

  dataPartTransformers: DataPartTransformers = {
    context: (data: ContextDataUIPart): TextPart[] => {
      const metadata = Object.entries(data.metadata)
        .map(([k, v]) => `<${k} value="${v.toString()}"/>`)
        .join('');
      const content = data.content
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join(' ');

      return [
        {
          type: 'text',
          text: `<context source-env="${data.sourceEnv}"><metadata>${metadata}</metadata><content>${content}</content></context>`,
        },
      ];
    },
    continue: (): TextPart[] => [
      {
        type: 'text',
        text: 'Continue.',
      },
    ],
  };
}

export const createCoreDataPartsExt: ExtensionFactory = {
  identifier: 'io.stagewise/core-data-parts',
  displayName: 'Core Data Parts',
  create: () => new CoreDataPartsExt(),
};

import type { IncomingMessage, ServerResponse } from 'node:http';

export function createAgentSite(manifest: {
  origin: string;
  pages: Record<string, unknown>;
  errorHtml: string;
}): {
  quality(accept: string, type: string): number;
  language(
    request: Pick<IncomingMessage, 'headers'>,
    available: Record<string, unknown>,
  ): string;
  handle(request: IncomingMessage, response: ServerResponse): void;
};

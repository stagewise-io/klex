import MarkdownIt from 'markdown-it';

import { assert, safeLink } from '../legal.ts';

export function renderMarkdown(body: string): string {
  const parser = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
  }).disable('image');
  parser.validateLink = safeLink;
  const tokens = parser.parse(body, {});
  const identifiers = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;
    assert(token.tag !== 'h1', 'Policy body headings must start at H2');
    const title = tokens[index + 1]?.content ?? 'section';
    const stem = `section-${
      title
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'heading'
    }`;
    let id = stem;
    let suffix = 2;
    while (identifiers.has(id)) id = `${stem}-${suffix++}`;
    identifiers.add(id);
    token.attrSet('id', id);
  }
  return parser.renderer.render(tokens, parser.options, {});
}

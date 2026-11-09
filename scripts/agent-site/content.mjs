import { parse } from 'parse5';

const ignoredTags = new Set([
  'script',
  'style',
  'svg',
  'template',
  'noscript',
  'nav',
]);
const blockTags = new Set([
  'article',
  'section',
  'div',
  'header',
  'footer',
  'main',
  'figure',
  'figcaption',
  'details',
  'summary',
  'p',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
]);

/** Build-time only: extract the same semantic copy shipped in prerendered HTML. */
class SiteContent {
  attribute(node, name) {
    return node.attrs?.find((item) => item.name === name)?.value;
  }

  find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.childNodes ?? []) {
      const match = this.find(child, predicate);
      if (match) return match;
    }
    return undefined;
  }

  text(node) {
    if (node.nodeName === '#text') return node.value;
    return (node.childNodes ?? []).map((child) => this.text(child)).join('');
  }

  hasMain(html) {
    return Boolean(this.find(parse(html), (node) => node.tagName === 'main'));
  }

  markdown(html, canonical) {
    const document = parse(html);
    const main = this.find(document, (node) => node.tagName === 'main');
    if (!main) throw new Error(`Missing semantic main content: ${canonical}`);
    const renderText = (value, node) => {
      let scope = node;
      while (
        scope &&
        this.attribute(scope, 'data-markdown-bot-names') === undefined
      )
        scope = scope.parentNode;
      const names =
        (scope ? this.attribute(scope, 'data-markdown-bot-names') : '')
          ?.split(',')
          .map((name) => name.trim())
          .filter(Boolean) ?? [];
      let text = value.replace(/\s+/g, ' ');
      for (const name of names)
        text = text.replace(
          new RegExp(
            `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?! \\(Klex Bot\\))`,
            'g',
          ),
          `${name} (Klex Bot)`,
        );
      return text.replace(/([\\`*_[\]])/g, '\\$1');
    };
    const render = (node) => {
      if (node.nodeName === '#text') return renderText(node.value, node);
      const tag = node.tagName;
      if (
        this.attribute(node, 'data-markdown') === 'exclude' ||
        (ignoredTags.has(tag) &&
          !(
            tag === 'nav' && this.attribute(node, 'data-markdown') === 'include'
          )) ||
        (this.attribute(node, 'data-markdown') !== 'include' &&
          (this.attribute(node, 'aria-hidden') === 'true' ||
            (this.attribute(node, 'hidden') !== undefined &&
              this.attribute(node, 'data-slot') !== 'accordion-content')))
      )
        return '';
      if (tag === 'pre') {
        const code = this.text(node).trim();
        const fence = '`'.repeat(
          Math.max(
            3,
            ...[...code.matchAll(/`+/g)].map((match) => match[0].length + 1),
          ),
        );
        return `\n\n${fence}\n${code}\n${fence}\n\n`;
      }
      if (tag === 'table') {
        const sections = (node.childNodes ?? []).filter((child) =>
          ['thead', 'tbody', 'tfoot'].includes(child.tagName),
        );
        const rows = sections.flatMap((section) =>
          (section.childNodes ?? []).filter((child) => child.tagName === 'tr'),
        );
        const caption = (node.childNodes ?? []).find(
          (child) => child.tagName === 'caption',
        );
        const cells = (row) =>
          (row.childNodes ?? []).filter((cell) =>
            ['th', 'td'].includes(cell.tagName),
          );
        const header = rows.find(
          (row) =>
            cells(row).length > 1 &&
            cells(row).every((cell) => cell.tagName === 'th'),
        );
        const labels = header
          ? cells(header).map((cell) =>
              render(cell).trim().replace(/\s+/g, ' '),
            )
          : [];
        return `\n\n${caption ? `${render(caption).trim()}\n\n` : ''}${rows
          .filter((row) => row !== header)
          .map((row) => {
            const entries = cells(row);
            if (entries.length === 1) return render(entries[0]);
            return entries
              .map(
                (cell, index) =>
                  `\n\n${labels[index] ? `**${labels[index]}:** ` : ''}${render(cell).trim()}\n\n`,
              )
              .join('');
          })
          .join('')}\n\n`;
      }
      if (tag === 'ol' || tag === 'ul') {
        if (this.attribute(node, 'data-markdown-layout') === 'sections')
          return `\n\n${(node.childNodes ?? [])
            .filter((child) => child.tagName === 'li')
            .map((child) =>
              (child.childNodes ?? []).map(render).join('').trim(),
            )
            .filter(Boolean)
            .join('\n\n')}\n\n`;
        const start = Number(this.attribute(node, 'start') ?? 1);
        return `\n\n${(node.childNodes ?? [])
          .filter((child) => child.tagName === 'li')
          .map((child, index) => {
            const content = (child.childNodes ?? [])
              .map(render)
              .join('')
              .trim();
            if (!content) return '';
            const marker = tag === 'ol' ? `${start + index}. ` : '- ';
            return (
              marker + content.replace(/\n/g, `\n${' '.repeat(marker.length)}`)
            );
          })
          .filter(Boolean)
          .join('\n\n')}\n\n`;
      }
      const replacement = this.attribute(node, 'data-markdown-text');
      const children =
        replacement === undefined
          ? (node.childNodes ?? []).map(render).join('')
          : renderText(replacement, node);
      if (/^h[1-6]$/.test(tag ?? ''))
        return children.trim()
          ? `\n\n${'#'.repeat(Number(tag[1]))} ${children.trim().replace(/\s+/g, ' ')}\n\n`
          : '';
      if (tag === 'br') return '\n';
      if (tag === 'li')
        return children.trim() ? `\n- ${children.trim()}\n` : '';
      if (tag === 'a') {
        const href = this.attribute(node, 'href');
        if (!children.trim() || !href) return children;
        const url = new URL(href, canonical);
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol))
          return children;
        return `[${children.trim()}](${url.href.replaceAll('(', '%28').replaceAll(')', '%29')})`;
      }
      if (tag === 'strong' || tag === 'b')
        return children.trim() ? `**${children.trim()}**` : '';
      if (tag === 'em' || tag === 'i')
        return children.trim() ? `*${children.trim()}*` : '';
      if (tag === 'caption') return `\n\n${children.trim()}\n\n`;
      if (tag === 'code') return `\`${this.text(node).replaceAll('`', '')}\``;
      if (tag === 'img') return this.attribute(node, 'alt') ?? '';
      return blockTags.has(tag) ? `\n\n${children.trim()}\n\n` : children;
    };
    const body = render(main)
      .split('\n')
      .map((line) => line.trimEnd().replace(/^ {1,2}(?=\S)/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const footer = this.find(document, (node) => node.tagName === 'footer');
    const footerLinks = new Map();
    const collectLinks = (node) => {
      if (this.attribute(node, 'data-markdown') === 'exclude') return;
      if (node.tagName === 'a') {
        const href = this.attribute(node, 'href');
        if (href) {
          const url = new URL(href, canonical);
          if (
            ['https:', 'http:', 'mailto:'].includes(url.protocol) &&
            !footerLinks.has(url.href)
          ) {
            const label =
              this.attribute(node, 'aria-label') ??
              (this.attribute(node, 'data-cloud-status') !== undefined
                ? 'Klex Cloud status'
                : render(node).match(/^\[([\s\S]*)\]\(/)?.[1]);
            if (label?.trim()) footerLinks.set(url.href, label.trim());
          }
        }
      }
      for (const child of node.childNodes ?? []) collectLinks(child);
    };
    if (footer) collectLinks(footer);
    const links = footerLinks.size
      ? `\n\n## Footer links\n\n${[...footerLinks].map(([url, label]) => `- [${label}](${url.replaceAll('(', '%28').replaceAll(')', '%29')})`).join('\n')}`
      : '';
    return `${body}${links}\n`;
  }

  measure(html) {
    const document = parse(html, { sourceCodeLocationInfo: true });
    const main = this.find(document, (node) => node.tagName === 'main');
    let svgCharacters = 0;
    const headings = [];
    const visibleText = (node) => {
      if (
        ignoredTags.has(node.tagName) ||
        this.attribute(node, 'aria-hidden') === 'true' ||
        (this.attribute(node, 'hidden') !== undefined &&
          this.attribute(node, 'data-slot') !== 'accordion-content')
      )
        return '';
      if (node.nodeName === '#text') return node.value;
      if (/^h[1-6]$/.test(node.tagName ?? ''))
        headings.push(Number(node.tagName[1]));
      return (node.childNodes ?? []).map(visibleText).join(' ');
    };
    const countSvg = (node) => {
      if (node.tagName === 'svg' && node.sourceCodeLocation) {
        svgCharacters +=
          node.sourceCodeLocation.endOffset -
          node.sourceCodeLocation.startOffset;
        return;
      }
      for (const child of node.childNodes ?? []) countSvg(child);
    };
    countSvg(document);
    const text = main ? visibleText(main).replace(/\s+/g, ' ').trim() : '';
    return {
      htmlCharacters: html.length,
      meaningfulTextCharacters: text.length,
      textRatio: text.length / html.length,
      svgCharacters,
      h1Count: headings.filter((level) => level === 1).length,
      headingSkips: headings.flatMap((level, index) =>
        index > 0 && level > headings[index - 1] + 1
          ? [{ from: headings[index - 1], to: level }]
          : [],
      ),
      note: 'Diagnostic semantic-main text/HTML character ratio; not the Ora scanner algorithm.',
    };
  }

  metadata(html) {
    const document = parse(html);
    const meta = (name) =>
      this.attribute(
        this.find(
          document,
          (node) =>
            node.tagName === 'meta' && this.attribute(node, 'name') === name,
        ) ?? {},
        'content',
      );
    return {
      title: this.text(
        this.find(document, (node) => node.tagName === 'title') ?? {},
      ).trim(),
      description: meta('description') ?? '',
      noindex: /(?:^|[,\s])noindex(?:$|[,\s])/i.test(meta('robots') ?? ''),
    };
  }
}

export const createSiteContent = () => new SiteContent();

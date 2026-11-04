import { createHash } from 'node:crypto';

import { parse } from 'parse5';

/** Externalize only contiguous static office geometry; keep bot portal hosts inline. */
class StaticArtwork {
  extract(html, officeStyles) {
    const document = parse(html, { sourceCodeLocationInfo: true });
    const replacements = [];
    const symbols = [];
    const assets = [];
    const styles = officeStyles
      .slice(
        officeStyles.indexOf('.office-human-figure'),
        officeStyles.indexOf('@media'),
      )
      .replaceAll('.office-drawing ', '');
    const containsLiveHost = (node) =>
      node.attrs?.some((attr) => attr.name === 'data-office-bot') ||
      (node.childNodes ?? []).some(containsLiveHost);
    const visit = (node, office = false, hydrated = false) => {
      const className =
        node.attrs?.find((attr) => attr.name === 'class')?.value ?? '';
      const inHydratedIsland =
        hydrated ||
        /(?:^|\s)new-(?:features|coworkers|guides-faq)-mount(?:\s|$)/.test(
          className,
        );
      if (
        node.tagName === 'svg' &&
        !inHydratedIsland &&
        className !== 'office-drawing' &&
        !office &&
        node.sourceCodeLocation
      ) {
        const location = node.sourceCodeLocation;
        const start = location.startTag.endOffset;
        const end = location.endTag.startOffset;
        const body = html
          .slice(start, end)
          .replace(/\sdata-pupil(?=[\s/>])/g, ' data-pupil=""');
        if (body.length > 128) {
          const id = 'artwork';
          const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g id="${id}">${body}</g></svg>`;
          const hash = createHash('sha256')
            .update(svg)
            .digest('hex')
            .slice(0, 16);
          const path = `assets/artwork-static-${hash}.svg`;
          assets.push({ path, body: svg });
          replacements.push({ start, end, reference: `/${path}#${id}` });
          return;
        }
      }
      const inOffice =
        office ||
        node.attrs?.some(
          (attr) =>
            attr.name === 'class' &&
            attr.value.split(' ').includes('office-drawing'),
        );
      if (inOffice) {
        let run = [];
        const flush = () => {
          if (!run.length) return;
          const start = run[0].sourceCodeLocation.startOffset;
          const end = run.at(-1).sourceCodeLocation.endOffset;
          const body = html.slice(start, end);
          if (body.length > 1024) {
            const id = `geometry-${symbols.length}`;
            symbols.push(`<g id="${id}"><style>${styles}</style>${body}</g>`);
            replacements.push({ start, end, id });
          }
          run = [];
        };
        for (const child of node.childNodes ?? []) {
          if (
            (['polygon', 'polyline'].includes(child.tagName) ||
              (child.tagName === 'g' && !containsLiveHost(child))) &&
            child.sourceCodeLocation
          )
            run.push(child);
          else if (child.nodeName !== '#text' || child.value.trim()) flush();
        }
        flush();
      }
      for (const child of node.childNodes ?? []) {
        const location = child.sourceCodeLocation;
        if (
          location &&
          replacements.some(
            (replacement) =>
              location.startOffset >= replacement.start &&
              location.endOffset <= replacement.end,
          )
        )
          continue;
        visit(child, inOffice, inHydratedIsland);
      }
    };
    visit(document);
    if (!symbols.length && !assets.length) return { html, assets: [] };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>`;
    const hash = createHash('sha256').update(svg).digest('hex').slice(0, 16);
    const path = `assets/office-static-${hash}.svg`;
    for (const replacement of replacements.toSorted(
      (a, b) => b.start - a.start,
    ))
      html = `${html.slice(0, replacement.start)}<use href="${replacement.reference ?? `/${path}#${replacement.id}`}" />${html.slice(replacement.end)}`;
    return {
      html,
      assets: [...assets, ...(symbols.length ? [{ path, body: svg }] : [])],
    };
  }
}

export const createStaticArtwork = () => new StaticArtwork();

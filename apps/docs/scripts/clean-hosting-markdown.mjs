import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// These elements only support the HTML tab interface. Keep them out of the
// generated Markdown and page JSON used by people and answer systems.
function strip(markdown) {
  return markdown
    .replace(
      /^<noscript><link rel="stylesheet" href="\/hosting-noscript\.css" \/><\/noscript>\r?\n?/gm,
      '',
    )
    .replace(
      /^<script src="\/(?:hosting-tabs|quickstart-tabs)\.js" defer><\/script>\r?\n?/gm,
      '',
    )
    .replace(/<div className="hosting-quickstart">([\s\S]*?)<\/div>/g, '$1');
}
async function clean(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await clean(path);
    else if (entry.name.endsWith('.md')) {
      const original = await readFile(path, 'utf8');
      const result = strip(original);
      if (result !== original) await writeFile(path, result);
    } else if (
      path.startsWith('dist/api/docs/pages/') &&
      entry.name.endsWith('.json')
    ) {
      const original = await readFile(path, 'utf8');
      if (
        !original.includes('hosting-tabs.js') &&
        !original.includes('quickstart-tabs.js') &&
        !original.includes('hosting-quickstart')
      )
        continue;
      const page = JSON.parse(original);
      if (typeof page.markdown === 'string')
        page.markdown = strip(page.markdown);
      await writeFile(path, JSON.stringify(page));
    }
  }
}
await clean('dist');

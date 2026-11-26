import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Remove HTML-only controls from Markdown, page JSON, and LLM text output.
function strip(markdown) {
  return (
    markdown
      .replace(
        /^<noscript><link rel="stylesheet" href="\/hosting-noscript\.css" \/><\/noscript>\r?\n?/gm,
        '',
      )
      .replace(
        /^<script src="\/(?:hosting-tabs|quickstart-tabs)\.js" defer><\/script>\r?\n?/gm,
        '',
      )
      .replace(/<div className="hosting-quickstart">([\s\S]*?)<\/div>/g, '$1')
      // The button and disclosure are HTML controls; retain the prompt itself.
      .replace(
        /^<button className="copy-agent-prompt"[^>]*>.*?<\/button>\r?\n?/gm,
        '',
      )
      .replace(
        /^<span className="copy-agent-prompt-status"[^>]*><\/span>\r?\n?/gm,
        '',
      )
      .replace(
        /^<details className="agent-prompt-details">\r?\n<summary>.*?<\/summary>\r?\n?/gm,
        '',
      )
      .replace(
        /^<\/details>\r?\n<script src="\/copy-agent-prompt\.js" defer><\/script>\r?\n?/gm,
        '',
      )
  );
}
async function clean(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await clean(path);
    else if (entry.name.endsWith('.md') || entry.name === 'llms-full.txt') {
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
        !original.includes('hosting-quickstart') &&
        !original.includes('copy-agent-prompt')
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

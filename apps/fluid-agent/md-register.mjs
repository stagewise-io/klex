import { register } from 'node:module';

// Registers a custom ESM load hook that treats .md files as text modules.
// This mirrors esbuild's `loader: { '.md': 'text' }` for tsx / Node ESM.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function load(url, context, nextLoad) {
        if (url.endsWith('.md')) {
          const { readFile } = await import('node:fs/promises');
          const content = await readFile(new URL(url), 'utf8');
          return {
            format: 'module',
            source: 'export default ' + JSON.stringify(content) + ';',
            shortCircuit: true,
          };
        }
        return nextLoad(url, context);
      }
    `),
  import.meta.url,
);

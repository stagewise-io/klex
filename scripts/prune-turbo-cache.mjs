// Keeps only the Turbo cache artifacts referenced by this job's run summaries.
// CI restores the previous cache, runs Turbo, then saves the directory again;
// without pruning, every main push would carry all historical artifacts forward.
// Requires the Turbo runs to have been made with TURBO_RUN_SUMMARY=true.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const cacheDir = process.env.TURBO_CACHE_DIR ?? '.turbo/cache';
const runsDir = '.turbo/runs';

if (!existsSync(cacheDir)) {
  console.log(`No Turbo cache at ${cacheDir}; nothing to prune.`);
  process.exit(0);
}

const keep = new Set();
if (existsSync(runsDir)) {
  for (const file of readdirSync(runsDir)) {
    if (!file.endsWith('.json')) continue;
    const summary = JSON.parse(readFileSync(join(runsDir, file), 'utf8'));
    for (const task of summary.tasks ?? []) {
      if (task.hash) keep.add(task.hash);
    }
  }
}

if (keep.size === 0) {
  // Pruning against an empty set would wipe the cache; fail so it is not saved.
  console.error(`No task hashes found in ${runsDir}; refusing to prune.`);
  process.exit(1);
}

let kept = 0;
let removed = 0;
for (const file of readdirSync(cacheDir)) {
  // Artifacts are <hash>.tar.zst, <hash>-meta.json and <hash>-manifest.json.
  const hash = /^[0-9a-f]+/.exec(file)?.[0];
  if (hash && keep.has(hash)) {
    kept += 1;
    continue;
  }
  rmSync(join(cacheDir, file), { recursive: true, force: true });
  removed += 1;
}

console.log(
  `Turbo cache: kept ${kept} files for ${keep.size} tasks, removed ${removed}.`,
);

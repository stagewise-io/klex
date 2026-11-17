import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The desktop has one platform-dependent wall: `DesktopProvider`. Native
 * access lives in src/desktop/platform/, and only the process entry point
 * picks a provider. Biome's noRestrictedImports override enforces the static
 * imports in editors; this also covers dynamic imports and non-import leaks.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const PLATFORM = `desktop${sep}platform${sep}`;
const ENTRY_POINTS = new Set(['index.ts']);
const AGNOSTIC_DESKTOP = (file: string) =>
  (file.startsWith(`desktop${sep}`) && !file.startsWith(PLATFORM)) ||
  file === join('cloud', 'desktop-link.ts');

const PLATFORM_IMPORT =
  /(?:from\s+|import\s*\(\s*)['"][^'"]*\/platform(?:\/[^'"]*)?['"]/;
const NATIVE_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:child_process|net|fs|fs\/promises|os|dgram|worker_threads)['"]/;
const PLATFORM_DETAIL =
  /\b(?:xdotool|wmctrl|xwininfo|xprop|Xvnc|DISPLAY|KLEX_MACHINE_VNC_SOCKET|AT_SPI_BUS(?:_ADDRESS)?|atspi|dbus)\b|org\.a11y|vnc\.sock|['"]import['"]/;

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(SRC, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(SRC, path), await readFile(path, 'utf8'));
  }
  return files;
}

function offending(
  files: Map<string, string>,
  include: (file: string) => boolean,
  pattern: RegExp,
): string[] {
  return [...files]
    .filter(([file, text]) => include(file) && pattern.test(text))
    .map(([file]) => file);
}

describe('desktop platform boundary', () => {
  it('keeps platform providers reachable only from the entry point', async () => {
    const files = await sources();
    expect(
      offending(
        files,
        (file) => !file.startsWith(PLATFORM) && !ENTRY_POINTS.has(file),
        PLATFORM_IMPORT,
      ),
    ).toEqual([]);
    expect(files.get('index.ts')).toMatch(PLATFORM_IMPORT);
  });

  it('keeps native access out of platform-independent desktop code', async () => {
    const files = await sources();
    expect(offending(files, AGNOSTIC_DESKTOP, NATIVE_IMPORT)).toEqual([]);
    expect(
      offending(files, AGNOSTIC_DESKTOP, /\bprocess\.(?:platform|env)\b/),
    ).toEqual([]);
  });

  it('keeps display, VNC and tool details inside the platform folder', async () => {
    const files = await sources();
    expect(
      offending(files, (file) => !file.startsWith(PLATFORM), PLATFORM_DETAIL),
    ).toEqual([]);
  });
});

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createDesktopProvider,
  MacosDesktopProvider,
  toMacosChord,
} from '../src/desktop/platform/index.js';
import {
  type MacosCommandRunner,
  type MacosDesktopProviderOptions,
  MISSING_HELPER_HINT,
  macosPermissionHint,
  NO_SESSION_HINT,
} from '../src/desktop/platform/macos.js';
import {
  type DesktopProviderFixture,
  describeDesktopProviderContract,
} from './desktop-provider-contract.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
/** A Retina panel: 1440x900 points backed by 2880x1800 pixels. */
const RETINA = {
  width: 1440,
  height: 900,
  pixelWidth: 2880,
  pixelHeight: 1800,
};

interface FakeMac {
  /** The helper binary is installed. */
  helper?: boolean;
  session?: boolean;
  screenRecording?: boolean;
  accessibility?: boolean;
  display?: typeof RETINA;
  /** `probe` exits nonzero. */
  probeFails?: boolean;
  windows?: unknown[];
}

interface Call {
  file: string;
  args: string[];
  input?: string;
  timeoutMs?: number;
}

/** A macOS provider whose helper, screencapture, sips and launcher are fakes. */
async function fakeMac(
  fake: FakeMac,
  options: Partial<MacosDesktopProviderOptions> = {},
): Promise<
  DesktopProviderFixture & {
    calls: Call[];
    helper: string;
    warnings: string[];
  }
> {
  const dir = await mkdtemp(join(tmpdir(), 'klex-machine-macos-'));
  const helper = join(dir, 'klex-desktop-helper');
  if (fake.helper !== false) {
    await writeFile(helper, '#!/bin/sh\nexit 1\n');
    await chmod(helper, 0o755);
  }
  const display = fake.display ?? RETINA;
  const calls: Call[] = [];
  const warnings: string[] = [];
  const run: MacosCommandRunner = async (file, args, { input, timeoutMs }) => {
    calls.push({
      file,
      args: [...args],
      ...(input !== undefined ? { input } : {}),
      ...(timeoutMs !== 15_000 ? { timeoutMs } : {}),
    });
    if (file === '/usr/sbin/screencapture') {
      await writeFile(args.at(-1) ?? '', PNG);
      return Buffer.alloc(0);
    }
    if (file === '/usr/bin/sips') {
      const out = args[args.indexOf('--out') + 1] ?? '';
      await writeFile(out, args.includes('jpeg') ? JPEG : PNG);
      return Buffer.alloc(0);
    }
    if (file !== helper) throw new Error(`spawn ${file} ENOENT`);
    switch (args[0]) {
      case 'probe':
        if (fake.probeFails) throw new Error(`${file} failed: abort trap`);
        return Buffer.from(
          JSON.stringify({
            ...display,
            session: fake.session ?? true,
            screenRecording: fake.screenRecording ?? true,
            accessibility: fake.accessibility ?? true,
          }),
        );
      case 'display':
        return Buffer.from(JSON.stringify(display));
      case 'windows':
        return Buffer.from(
          JSON.stringify(
            fake.windows ?? [
              {
                id: '42',
                pid: 300,
                app: 'Terminal',
                title: 'zsh',
                x: 10,
                y: 25,
                width: 600,
                height: 400,
                focused: true,
              },
            ],
          ),
        );
      case 'launch-app':
        return Buffer.from('{"pid":31}\n');
      default:
        return Buffer.alloc(0);
    }
  };
  return {
    calls,
    helper,
    warnings,
    provider: new MacosDesktopProvider({
      env: {},
      helperPath: helper,
      run,
      launch: async () => ({ pid: 4242 }),
      warn: (hint) => warnings.push(hint),
      ...options,
    }),
    async close() {
      await rm(dir, { force: true, recursive: true });
    },
  };
}

describeDesktopProviderContract(
  'macOS with Screen Recording and Accessibility',
  { computerUse: true, stream: false },
  () => fakeMac({}),
);
describeDesktopProviderContract(
  'macOS without Screen Recording permission',
  { computerUse: false, stream: false },
  () => fakeMac({ screenRecording: false }),
);
describeDesktopProviderContract(
  'macOS without Accessibility permission',
  { computerUse: false, stream: false },
  () => fakeMac({ accessibility: false }),
);
describeDesktopProviderContract(
  'macOS without a login session',
  { computerUse: false, stream: false },
  () => fakeMac({ session: false }),
);
describeDesktopProviderContract(
  'macOS without the helper binary',
  { computerUse: false, stream: false },
  () => fakeMac({ helper: false }),
);
describeDesktopProviderContract(
  'macOS with a crashing helper',
  { computerUse: false, stream: false },
  () => fakeMac({ probeFails: true }),
);

describe('createDesktopProvider on macOS', () => {
  it('uses the macOS provider unless the desktop is turned off', () => {
    expect(createDesktopProvider({}, 'darwin')).toBeInstanceOf(
      MacosDesktopProvider,
    );
    expect(
      createDesktopProvider({ KLEX_MACHINE_DESKTOP: 'off' }, 'darwin'),
    ).toBeUndefined();
  });
});

describe('MacosDesktopProvider probe', () => {
  it('reports the screen in physical pixels', async () => {
    const fixture = await fakeMac({});
    try {
      expect(await fixture.provider.probe()).toEqual({
        computerUse: true,
        stream: false,
        screen: { width: 2880, height: 1800 },
      });
      expect(await fixture.provider.screenSize()).toEqual({
        width: 2880,
        height: 1800,
      });
      expect(fixture.warnings).toEqual([]);
    } finally {
      await fixture.close?.();
    }
  });

  it('explains how to grant missing permissions, once per change', async () => {
    const fixture = await fakeMac(
      { screenRecording: false, accessibility: false },
      { env: { TERM_PROGRAM: 'Apple_Terminal' } },
    );
    try {
      const first = await fixture.provider.probe();
      await fixture.provider.probe();
      expect(first).toEqual({
        computerUse: false,
        stream: false,
        hint: expect.any(String),
      });
      expect(first.hint).toMatch(
        /needs Screen Recording and Accessibility permission/,
      );
      expect(first.hint).toMatch(/turn on Terminal/);
      expect(first.hint).toMatch(/quit and reopen Terminal/);
      expect(first.hint).toContain(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      );
      expect(first.hint).toContain(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      );
      expect(fixture.warnings).toEqual([first.hint]);
      expect(
        fixture.calls.filter(({ file }) => file === fixture.helper),
      ).toEqual([
        { file: fixture.helper, args: ['probe'] },
        { file: fixture.helper, args: ['probe'] },
      ]);
    } finally {
      await fixture.close?.();
    }
  });

  it('names only the missing permission and a generic app when unknown', () => {
    const hint = macosPermissionHint(['Accessibility'], {});
    expect(hint).toMatch(
      /^Computer use on macOS needs Accessibility permission/,
    );
    expect(hint).not.toContain('Screen Recording');
    expect(hint).toMatch(/the app that starts klex-machine/);
    expect(hint).not.toContain('Privacy_ScreenCapture');
  });

  it('reports a missing helper, a missing session and helper failures', async () => {
    for (const [fake, hint] of [
      [{ helper: false }, MISSING_HELPER_HINT],
      [{ session: false }, NO_SESSION_HINT],
      [{ probeFails: true }, expect.stringMatching(/helper failed: .*abort/)],
    ] as const) {
      const fixture = await fakeMac(fake);
      try {
        expect(await fixture.provider.probe()).toEqual({
          computerUse: false,
          stream: false,
          hint,
        });
      } finally {
        await fixture.close?.();
      }
    }
  });

  it('never rejects, even when the runner throws synchronously', async () => {
    const provider = new MacosDesktopProvider({
      env: {},
      helperPath: '/bin/sh',
      run: () => {
        throw new Error('boom');
      },
      warn: () => undefined,
    });
    expect(await provider.probe()).toMatchObject({ computerUse: false });
  });

  it('runs nothing but the helper probe', async () => {
    const fixture = await fakeMac({});
    try {
      await fixture.provider.probe();
      expect(fixture.calls.map(({ file, args }) => [file, ...args])).toEqual([
        [fixture.helper, 'probe'],
      ]);
    } finally {
      await fixture.close?.();
    }
  });
});

describe('MacosDesktopProvider on a Retina display', () => {
  it('converts pixels to points for input', async () => {
    const fixture = await fakeMac({});
    try {
      const { provider, calls, helper } = fixture;
      await provider.click({ x: 101, y: 50 }, 'right', 2, ['Ctrl', 'cmd']);
      await provider.move({ x: 2879, y: 1799 });
      await provider.drag({ x: 0, y: 0 }, { x: 200, y: 400 }, 'left');
      await provider.scroll({ x: 20, y: 40 }, 'down', 3);
      expect(
        calls
          .filter(({ file, args }) => file === helper && args[0] !== 'display')
          .map(({ args }) => args),
      ).toEqual([
        ['click', '50.5', '25', 'right', '2', 'ctrl,cmd'],
        ['move', '1439.5', '899.5'],
        ['drag', '0', '0', '100', '200', 'left'],
        ['scroll', '10', '20', 'down', '3'],
      ]);
    } finally {
      await fixture.close?.();
    }
  });

  it('re-reads the display scale once it is stale', async () => {
    let now = 0;
    const fixture = await fakeMac({}, { now: () => now });
    try {
      const displayReads = () =>
        fixture.calls.filter(({ args }) => args[0] === 'display').length;
      await fixture.provider.screenSize();
      await fixture.provider.move({ x: 1, y: 1 });
      expect(displayReads()).toBe(1);
      now = 5_000;
      await fixture.provider.move({ x: 1, y: 1 });
      expect(displayReads()).toBe(2);
    } finally {
      await fixture.close?.();
    }
  });

  it('scales window bounds to pixels and labels windows with their app', async () => {
    const fixture = await fakeMac({
      windows: [
        {
          id: '42',
          app: 'Terminal',
          title: 'zsh',
          x: 10,
          y: 25,
          width: 600,
          height: 400,
          focused: true,
        },
        {
          id: '43',
          app: 'Finder',
          title: '',
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          focused: false,
        },
        { id: '44', app: 'Dock', title: '', x: 0, y: 0, width: 0, height: 0 },
        { id: 'nope', app: 'Bad', x: 0, y: 0, width: 10, height: 10 },
      ],
    });
    try {
      expect(await fixture.provider.listWindows()).toEqual([
        {
          id: '42',
          title: 'zsh - Terminal',
          bounds: { x: 20, y: 50, width: 1200, height: 800 },
          focused: true,
        },
        {
          id: '43',
          title: 'Finder',
          bounds: { x: 0, y: 0, width: 600, height: 400 },
          focused: false,
        },
      ]);
      await fixture.provider.focusWindow('42');
      await expect(fixture.provider.focusWindow('42; rm')).rejects.toThrow(
        'Invalid window id',
      );
      expect(fixture.calls.at(-1)?.args).toEqual(['focus', '42']);
    } finally {
      await fixture.close?.();
    }
  });

  it('captures a pixel region as covering points, then scales and encodes', async () => {
    const fixture = await fakeMac({});
    try {
      const image = await fixture.provider.capture({
        region: { x: 11, y: 21, width: 10, height: 10 },
        size: { width: 20, height: 30 },
        format: 'jpeg',
      });
      expect(image).toEqual(JPEG);
      const [capture, convert] = fixture.calls.filter(
        ({ file }) => file !== fixture.helper,
      );
      expect(capture?.file).toBe('/usr/sbin/screencapture');
      expect(capture?.args.slice(0, -1)).toEqual([
        '-x',
        '-t',
        'png',
        '-R',
        '5,10,6,6',
      ]);
      expect(convert?.file).toBe('/usr/bin/sips');
      expect(convert?.args).toEqual([
        '-z',
        '30',
        '20',
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '75',
        capture?.args.at(-1),
        '--out',
        expect.stringMatching(/screen-out\.jpeg$/),
      ]);
    } finally {
      await fixture.close?.();
    }
  });

  it('captures the main display as PNG without converting', async () => {
    const fixture = await fakeMac({});
    try {
      expect(await fixture.provider.capture({ format: 'png' })).toEqual(PNG);
      const files = fixture.calls
        .filter(({ file }) => file !== fixture.helper)
        .map(({ file, args }) => [file, ...args.slice(0, -1)]);
      expect(files).toEqual([
        ['/usr/sbin/screencapture', '-x', '-t', 'png', '-m'],
      ]);
    } finally {
      await fixture.close?.();
    }
  });
});

describe('MacosDesktopProvider keyboard and launch', () => {
  it('maps generic combos to helper chords', () => {
    expect(toMacosChord('Cmd+Shift+T')).toBe('cmd,shift|char:t');
    expect(toMacosChord('ctrl+a')).toBe('ctrl|char:a');
    expect(toMacosChord('super+L')).toBe('cmd|char:l');
    expect(toMacosChord('alt+option+left')).toBe('alt|code:123');
    expect(toMacosChord('Enter')).toBe('|code:36');
    expect(toMacosChord('f5')).toBe('|code:96');
    expect(toMacosChord('F20')).toBe('|code:90');
    expect(toMacosChord('cmd+plus')).toBe('cmd|char:+');
    expect(toMacosChord('backspace')).toBe('|code:51');
    expect(toMacosChord('delete')).toBe('|code:117');
    expect(toMacosChord('cmd')).toBe('|code:55');
    expect(toMacosChord('cmd+/')).toBe('cmd|char:/');
    expect(() => toMacosChord('ctrl+')).toThrow('Invalid key combo');
    expect(() => toMacosChord('ctrl+$(x)')).toThrow('Unsupported key name');
    expect(() => toMacosChord('ctrl+é')).toThrow('Unsupported key name');
    expect(() => toMacosChord('f21')).toThrow('macOS has no F21 key');
    expect(() => toMacosChord('f25')).toThrow('Unsupported key name');
    expect(() => toMacosChord('a+b')).toThrow('Unsupported modifier');
  });

  it('passes typed text on stdin, never in arguments', async () => {
    const fixture = await fakeMac({});
    try {
      const text = `${'x'.repeat(250)}; rm -rf / $(x)`;
      await fixture.provider.type(text);
      await fixture.provider.key(['cmd+L', 'Enter']);
      const helperCalls = fixture.calls.filter(
        ({ file }) => file === fixture.helper,
      );
      expect(helperCalls).toEqual([
        { file: fixture.helper, args: ['type'], input: 'x'.repeat(200) },
        {
          file: fixture.helper,
          args: ['type'],
          input: `${'x'.repeat(50)}; rm -rf / $(x)`,
        },
        { file: fixture.helper, args: ['key', 'cmd|char:l', '|code:36'] },
      ]);
    } finally {
      await fixture.close?.();
    }
  });

  it('rejects bad modifiers and keys before running the helper', async () => {
    const fixture = await fakeMac({});
    try {
      await expect(
        fixture.provider.click({ x: 1, y: 1 }, 'left', 1, ['hyper']),
      ).rejects.toThrow('Unsupported modifier');
      await expect(fixture.provider.key(['ctrl+$(x)'])).rejects.toThrow(
        'Unsupported key name',
      );
      expect(fixture.calls).toEqual([]);
    } finally {
      await fixture.close?.();
    }
  });

  it('opens app bundles through the helper and spawns everything else', async () => {
    const launch = vi.fn(async () => ({ pid: 77 }));
    const fixture = await fakeMac({}, { launch });
    try {
      expect(
        await fixture.provider.launch({
          command: '/Applications/Safari.app/',
          args: ['https://example.com'],
        }),
      ).toEqual({ pid: 31 });
      expect(fixture.calls.at(-1)).toEqual({
        file: fixture.helper,
        args: ['launch-app', '/Applications/Safari.app', 'https://example.com'],
        timeoutMs: 45_000,
      });
      expect(
        await fixture.provider.launch({
          command: 'open',
          args: ['-a', 'TextEdit'],
          cwd: '/tmp',
        }),
      ).toEqual({ pid: 77 });
      expect(launch).toHaveBeenCalledWith({
        command: 'open',
        args: ['-a', 'TextEdit'],
        cwd: '/tmp',
        env: {},
      });
    } finally {
      await fixture.close?.();
    }
  });

  it('fails input clearly when the helper is missing', async () => {
    const fixture = await fakeMac({ helper: false });
    try {
      await expect(fixture.provider.move({ x: 1, y: 1 })).rejects.toThrow(
        MISSING_HELPER_HINT,
      );
    } finally {
      await fixture.close?.();
    }
  });
});

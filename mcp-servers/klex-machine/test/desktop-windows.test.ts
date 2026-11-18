import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createDesktopProvider,
  toWindowsKeyCombo,
  WindowsDesktopProvider,
} from '../src/desktop/platform/index.js';
import {
  type HelperSpawner,
  PowerShellDesktopHelper,
  type WindowsDesktopHelper,
} from '../src/desktop/platform/windows.js';
import {
  WINDOWS_HELPER_READY,
  WINDOWS_HELPER_SOURCE,
  windowsHelperBootstrap,
} from '../src/desktop/platform/windows-helper.js';
import {
  type DesktopProviderFixture,
  describeDesktopProviderContract,
} from './desktop-provider-contract.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const b64 = (text: string) => Buffer.from(text).toString('base64');

interface FakeWindows {
  session?: string;
  interactive?: boolean;
  desktop?: string;
  capture?: string;
  /** The helper cannot start, as under Constrained Language Mode. */
  broken?: boolean;
}

function probeOutput(fake: FakeWindows): string {
  return [
    `session=${fake.session ?? '1'}`,
    `interactive=${fake.interactive === false ? '0' : '1'}`,
    `desktop=${b64(fake.desktop ?? 'Default')}`,
    'dpi=per-monitor-v2',
    'width=1920',
    'height=1080',
    `capture=${fake.capture === undefined ? 'ok' : b64(fake.capture)}`,
  ].join('\t');
}

function fakeHelper(fake: FakeWindows = {}) {
  const calls: [string, ...string[]][] = [];
  const helper: WindowsDesktopHelper = async (request, args) => {
    calls.push([request, ...args]);
    if (fake.broken) throw new Error('PowerShell exited with code 3');
    switch (request) {
      case 'probe':
        return probeOutput(fake);
      case 'size':
        return '1920 1080';
      case 'capture':
        return JPEG.toString('base64');
      case 'windows':
        return [
          `65538,0,0,800,600,0,${b64('Terminal')}`,
          `131074,-8,10,1024,768,1,${b64('Ünïcode, title; with\ttabs')}`,
          'garbage',
        ].join(';');
      default:
        return '';
    }
  };
  return { helper, calls };
}

function fakeWindows(fake: FakeWindows = {}): DesktopProviderFixture {
  return {
    provider: new WindowsDesktopProvider({
      env: {},
      helper: fakeHelper(fake).helper,
      launch: async () => ({ pid: 4242 }),
      warn: () => undefined,
    }),
  };
}

describeDesktopProviderContract(
  'Windows on the signed-in desktop',
  { computerUse: true, stream: false },
  async () => fakeWindows(),
);
describeDesktopProviderContract(
  'Windows in Session 0',
  { computerUse: false, stream: false },
  async () => fakeWindows({ session: '0', interactive: false }),
);
describeDesktopProviderContract(
  'Windows on a non-interactive window station',
  { computerUse: false, stream: false },
  async () => fakeWindows({ interactive: false }),
);
describeDesktopProviderContract(
  'Windows while locked or on the UAC secure desktop',
  { computerUse: false, stream: false },
  async () => fakeWindows({ desktop: 'Winlogon' }),
);
describeDesktopProviderContract(
  'Windows without a working helper',
  { computerUse: false, stream: false },
  async () => fakeWindows({ broken: true }),
);

describe('createDesktopProvider on Windows', () => {
  it('uses the Windows provider unless the desktop is turned off', () => {
    expect(createDesktopProvider({}, 'win32')).toBeInstanceOf(
      WindowsDesktopProvider,
    );
    expect(
      createDesktopProvider({ KLEX_MACHINE_DESKTOP: 'off' }, 'win32'),
    ).toBeUndefined();
  });
});

describe('WindowsDesktopProvider', () => {
  function provider(fake: FakeWindows = {}) {
    const { helper, calls } = fakeHelper(fake);
    const warnings: string[] = [];
    return {
      calls,
      warnings,
      backend: new WindowsDesktopProvider({
        env: {},
        helper,
        launch: async () => ({ pid: 7 }),
        warn: (hint) => warnings.push(hint),
      }),
    };
  }

  it('explains Session 0 and stops asking the helper', async () => {
    const { backend, calls, warnings } = provider({
      session: '0',
      interactive: false,
    });
    const first = await backend.probe();
    expect(first).toMatchObject({ computerUse: false, stream: false });
    expect(first.hint).toMatch(/Session 0.*signed-in user's session/);
    expect(await backend.probe()).toEqual(first);
    expect(calls).toEqual([['probe']]);
    expect(warnings).toEqual([first.hint]);
  });

  it('explains a non-interactive window station', async () => {
    const { backend } = provider({ interactive: false });
    expect((await backend.probe()).hint).toMatch(/not interactive/);
  });

  it('reports the lock screen and UAC prompts, then recovers', async () => {
    const fake: FakeWindows = { desktop: 'Winlogon' };
    const { backend, warnings } = provider(fake);
    expect((await backend.probe()).hint).toMatch(
      /"Winlogon".*locked.*UAC prompt.*cannot be captured or driven/,
    );
    fake.desktop = '';
    expect((await backend.probe()).hint).toMatch(/not accessible/);
    fake.desktop = 'Default';
    expect(await backend.probe()).toEqual({
      computerUse: true,
      stream: false,
      screen: { width: 1920, height: 1080 },
    });
    fake.desktop = 'Winlogon';
    await backend.probe();
    expect(warnings).toHaveLength(3);
    expect(warnings[2]).toBe(warnings[0]);
  });

  it('reports failed captures and helpers that do not start', async () => {
    expect(
      (await provider({ capture: 'The handle is invalid' }).backend.probe())
        .hint,
    ).toMatch(/Screen capture failed: The handle is invalid\..*Remote Desktop/);
    expect((await provider({ broken: true }).backend.probe()).hint).toMatch(
      /helper did not start: PowerShell exited with code 3\..*Constrained Language Mode/,
    );
  });

  it('builds helper requests without a shell', async () => {
    const { backend, calls } = provider();
    await backend.click({ x: 5.4, y: 6 }, 'right', 2, ['Ctrl', 'shift']);
    await backend.click({ x: 1, y: 1 }, 'left', 1, []);
    await backend.type('a; rm -rf / $(x)\n');
    await backend.key(['cmd+L', 'Enter', 'ctrl+shift+t', 'f5', 'ctrl+plus']);
    await backend.scroll({ x: 1, y: 2 }, 'down', 4);
    await backend.drag({ x: 1, y: 2 }, { x: 30, y: 40 }, 'left');
    await backend.move({ x: 9, y: 8 });
    await backend.focusWindow('65538');
    expect(calls).toEqual([
      ['click', '5', '6', 'right', '2', '17,16'],
      ['click', '1', '1', 'left', '1', '-'],
      ['type', b64('a; rm -rf / $(x)\n')],
      ['key', 'v91+v76', 'v13', 'v17+v16+v84', 'v116', 'v17+c43'],
      ['scroll', '1', '2', 'down', '4'],
      ['drag', '1', '2', '30', '40', 'left'],
      ['move', '9', '8'],
      ['focus', '65538'],
    ]);
  });

  it('types long text in chunks without splitting characters', async () => {
    const { backend, calls } = provider();
    const text = `${'a'.repeat(199)}😀${'b'.repeat(10)}`;
    await backend.type(text);
    const chunks = calls.map(([, arg]) =>
      Buffer.from(arg ?? '', 'base64').toString('utf8'),
    );
    expect(chunks).toEqual([`${'a'.repeat(199)}😀`, 'b'.repeat(10)]);
  });

  it('captures regions and decodes the image', async () => {
    const { backend, calls } = provider();
    expect(
      await backend.capture({
        region: { x: 1, y: 2, width: 3, height: 4 },
        size: { width: 30, height: 40 },
        format: 'jpeg',
      }),
    ).toEqual(JPEG);
    await backend.capture({ format: 'png' });
    expect(calls).toEqual([
      ['capture', '1', '2', '3', '4', '30', '40', 'jpeg'],
      ['capture', '-', '-', '-', '-', '-', '-', 'png'],
    ]);
  });

  it('parses the window list and rejects bad window ids', async () => {
    const { backend } = provider();
    expect(await backend.listWindows()).toEqual([
      {
        id: '65538',
        title: 'Terminal',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        focused: false,
      },
      {
        id: '131074',
        title: 'Ünïcode, title; with\ttabs',
        bounds: { x: -8, y: 10, width: 1024, height: 768 },
        focused: true,
      },
    ]);
    await expect(backend.focusWindow('1; calc')).rejects.toThrow(
      'Invalid window id',
    );
  });

  it('validates keys and modifiers before they reach the helper', async () => {
    const { backend, calls } = provider();
    expect(toWindowsKeyCombo('Ctrl+Alt+Delete')).toBe('v17+v18+v46');
    expect(toWindowsKeyCombo('Page_Down')).toBe('v34');
    expect(toWindowsKeyCombo('F24')).toBe('v135');
    expect(toWindowsKeyCombo('ctrl+/')).toBe('v17+c47');
    expect(() => toWindowsKeyCombo('ctrl+')).toThrow('Invalid key combo');
    expect(() => toWindowsKeyCombo('ctrl+$(x)')).toThrow(
      'Unsupported key name',
    );
    expect(() => toWindowsKeyCombo('F25')).toThrow('Unsupported key name');
    await expect(
      backend.click({ x: 1, y: 1 }, 'left', 1, ['enter']),
    ).rejects.toThrow('Unsupported modifier');
    expect(calls).toEqual([]);
  });

  it('has no stream or accessibility yet', async () => {
    const { backend } = provider();
    await expect(backend.openStream()).rejects.toThrow(
      'not available on Windows',
    );
    expect(backend).not.toHaveProperty('accessibilityTree');
  });
});

/** A `powershell.exe` stand-in that speaks the helper's line protocol. */
class FakePowerShell extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: string[] = [];
  killed = false;

  constructor(
    reply: (line: string, shell: FakePowerShell) => string | undefined,
    banner = '',
  ) {
    super();
    let buffer = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      for (
        let end = buffer.indexOf('\n');
        end !== -1;
        end = buffer.indexOf('\n')
      ) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        this.received.push(line);
        if (this.received.length === 1) {
          this.stdout.write(`${banner}klex-desktop-ready\r\n`);
          continue;
        }
        const answer = reply(line, this);
        if (answer !== undefined) this.stdout.write(`${answer}\n`);
      }
    });
  }

  exit(code: number, stderr = ''): void {
    if (stderr) this.stderr.write(stderr);
    setImmediate(() => this.emit('close', code, null));
  }

  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', null, 'SIGTERM'));
    return true;
  }
}

function fakeSpawner(
  reply: (line: string, shell: FakePowerShell) => string | undefined,
  banner?: string,
) {
  const shells: FakePowerShell[] = [];
  const spawns: { file: string; args: readonly string[]; cwd?: unknown }[] = [];
  const spawn: HelperSpawner = (file, args, options) => {
    spawns.push({ file, args, cwd: options.cwd });
    const shell = new FakePowerShell(reply, banner);
    shells.push(shell);
    return shell as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawn, shells, spawns };
}

describe('PowerShellDesktopHelper', () => {
  it('starts Windows PowerShell once and feeds it the helper over stdin', async () => {
    const { spawn, shells, spawns } = fakeSpawner(
      (line) => `ok\t${line.toUpperCase()}`,
      'Windows PowerShell\r\nPS C:\\> ',
    );
    const helper = new PowerShellDesktopHelper({
      env: { SystemRoot: 'D:\\Win' },
      spawn,
    });
    try {
      expect(await helper.request('size', [])).toBe('SIZE');
      expect(await helper.request('move', ['1', '2'])).toBe('MOVE\t1\t2');
      expect(spawns).toEqual([
        {
          file: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
          cwd: 'D:\\Win\\System32',
        },
      ]);
      expect(shells[0]?.received).toEqual([
        windowsHelperBootstrap(),
        'size',
        'move\t1\t2',
      ]);
    } finally {
      helper.close();
    }
  });

  it('serializes concurrent requests', async () => {
    const { spawn, shells } = fakeSpawner((line) => `ok\t${line}`);
    const helper = new PowerShellDesktopHelper({ env: {}, spawn });
    try {
      const results = await Promise.all(
        ['a', 'b', 'c'].map((request) => helper.request(request, [])),
      );
      expect(results).toEqual(['a', 'b', 'c']);
      expect(shells).toHaveLength(1);
    } finally {
      helper.close();
    }
  });

  it('decodes helper errors and keeps the process', async () => {
    const { spawn, shells } = fakeSpawner((line) =>
      line === 'bad' ? `err\t${b64('Windows blocked the input')}` : 'ok\t',
    );
    const helper = new PowerShellDesktopHelper({ env: {}, spawn });
    try {
      await expect(helper.request('bad', [])).rejects.toThrow(
        'Windows blocked the input',
      );
      expect(await helper.request('good', [])).toBe('');
      expect(shells).toHaveLength(1);
    } finally {
      helper.close();
    }
  });

  it('reassembles large replies split across chunks', async () => {
    const image = 'x'.repeat(200_000);
    const { spawn } = fakeSpawner((_line, shell) => {
      shell.stdout.write('ok\t');
      for (let i = 0; i < image.length; i += 7_000) {
        shell.stdout.write(image.slice(i, i + 7_000));
      }
      return '';
    });
    const helper = new PowerShellDesktopHelper({ env: {}, spawn });
    try {
      expect(await helper.request('capture', [])).toBe(image);
    } finally {
      helper.close();
    }
  });

  it('kills a hung helper and starts a new one for the next request', async () => {
    const { spawn, shells } = fakeSpawner((line) =>
      line === 'hang' ? undefined : 'ok\tfine',
    );
    const helper = new PowerShellDesktopHelper({
      env: {},
      spawn,
      requestTimeoutMs: 50,
    });
    try {
      await expect(helper.request('hang', [])).rejects.toThrow(
        'did not answer within 50 ms',
      );
      expect(shells[0]?.killed).toBe(true);
      expect(await helper.request('size', [])).toBe('fine');
      expect(shells).toHaveLength(2);
      // The replacement first lets go of keys and buttons the killed one held.
      expect(shells[1]?.received.slice(1)).toEqual(['size']);
    } finally {
      helper.close();
    }
  });

  it('reports why PowerShell exited and restarts it', async () => {
    const { spawn, shells } = fakeSpawner((line, shell) => {
      if (line === 'crash') {
        shell.exit(3, 'klex-desktop: Cannot add type.\r\n');
        return undefined;
      }
      return 'ok\tback';
    });
    const helper = new PowerShellDesktopHelper({ env: {}, spawn });
    try {
      await expect(helper.request('crash', [])).rejects.toThrow(
        'PowerShell exited with code 3: klex-desktop: Cannot add type.',
      );
      expect(await helper.request('size', [])).toBe('back');
      expect(shells).toHaveLength(2);
      expect(shells[1]?.received.slice(1)).toEqual(['size']);
    } finally {
      helper.close();
    }
  });

  it('releases what a lost request held before queued requests run', async () => {
    const { spawn, shells } = fakeSpawner((line) =>
      line.startsWith('click') || line.startsWith('key')
        ? undefined
        : 'ok\tfine',
    );
    const helper = new PowerShellDesktopHelper({
      env: {},
      spawn,
      requestTimeoutMs: 50,
    });
    try {
      const click = helper.request('click', ['1', '2', 'right', '1', '17,16']);
      const size = helper.request('size', []);
      await expect(click).rejects.toThrow('did not answer');
      expect(await size).toBe('fine');
      expect(shells[1]?.received.slice(1)).toEqual([
        'release\tv17+v16\tright',
        'size',
      ]);

      await expect(helper.request('key', ['v17+c43', 'v13'])).rejects.toThrow(
        'did not answer',
      );
      expect(shells[2]?.received.slice(1)).toEqual(['release\tv17+c43+v13\t-']);
    } finally {
      helper.close();
    }
  });

  it('starts nothing after close() and releases nothing for reported errors', async () => {
    const { spawn, shells } = fakeSpawner((line) =>
      line.startsWith('drag') ? undefined : `err\t${b64('no')}`,
    );
    const helper = new PowerShellDesktopHelper({ env: {}, spawn });
    await expect(
      helper.request('click', ['1', '1', 'left', '1', '17']),
    ).rejects.toThrow('no');
    const drag = helper.request('drag', ['1', '1', '2', '2', 'left']);
    const queued = helper.request('size', []);
    await new Promise((resolve) => setTimeout(resolve, 10));
    helper.close();
    await expect(drag).rejects.toThrow('stopped');
    await expect(queued).rejects.toThrow('stopped');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shells).toHaveLength(1);
    expect(shells[0]?.received.slice(1)).toEqual([
      'click\t1\t1\tleft\t1\t17',
      'drag\t1\t1\t2\t2\tleft',
    ]);
    await expect(helper.request('size', [])).rejects.toThrow('no');
    expect(shells).toHaveLength(2);
    helper.close();
  });

  it('fails startup when PowerShell is missing', async () => {
    const helper = new PowerShellDesktopHelper({
      env: {},
      spawn: () => {
        const shell = new FakePowerShell(() => undefined);
        shell.stdin.removeAllListeners('data');
        setImmediate(() => {
          shell.emit(
            'error',
            Object.assign(new Error('spawn powershell.exe ENOENT'), {
              code: 'ENOENT',
            }),
          );
          shell.emit('close', -2, null);
        });
        return shell as unknown as ChildProcessWithoutNullStreams;
      },
    });
    await expect(helper.request('probe', [])).rejects.toThrow('ENOENT');
  });

  it('rejects arguments that would break the line protocol', async () => {
    const { spawn, shells } = fakeSpawner(() => 'ok\t');
    const helper = new PowerShellDesktopHelper({ env: {}, spawn });
    await expect(helper.request('focus', ['1\tx'])).rejects.toThrow(
      'cannot contain tabs or newlines',
    );
    expect(shells).toHaveLength(0);
  });

  it('keeps the helper source free of template syntax and newer C#', () => {
    expect(WINDOWS_HELPER_SOURCE).not.toMatch(/\$"|\?\.|nameof\(|=>/);
    expect(windowsHelperBootstrap()).not.toMatch(/[\r\n]/);
    expect(WINDOWS_HELPER_SOURCE).toContain(`"${WINDOWS_HELPER_READY}"`);
  });
});

/**
 * Runs only on real Windows, such as the windows-latest CI job, against the
 * real PowerShell helper. GitHub's hosted runners have an interactive
 * desktop; elsewhere the probe must still resolve with a hint.
 */
describe.runIf(process.platform === 'win32')(
  'WindowsDesktopProvider on real Windows',
  { timeout: 120_000 },
  () => {
    const requireDesktop = process.env.GITHUB_ACTIONS === 'true';

    describeDesktopProviderContract(
      'Windows with the PowerShell helper',
      { computerUse: requireDesktop, stream: false },
      async () => {
        const provider = new WindowsDesktopProvider({
          // The contract launches `true`, which Windows does not have.
          launch: async () => ({ pid: process.pid }),
        });
        return { provider, close: async () => provider.close() };
      },
    );

    it('captures real images and lists windows', async () => {
      const provider = new WindowsDesktopProvider();
      try {
        const capabilities = await provider.probe();
        if (!requireDesktop && !capabilities.computerUse) {
          expect(capabilities.hint).toEqual(expect.any(String));
          return;
        }
        expect(capabilities, capabilities.hint).toMatchObject({
          computerUse: true,
        });
        const png = await provider.capture({ format: 'png' });
        expect(png.subarray(0, 8)).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        // IHDR width and height are the physical screen size.
        expect({
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
        }).toEqual(capabilities.screen);
        const jpeg = await provider.capture({
          format: 'jpeg',
          region: { x: 0, y: 0, width: 64, height: 32 },
          size: { width: 32, height: 16 },
        });
        expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        await provider.key(['shift', 'ctrl+/', 'f5']);
        for (const window of await provider.listWindows()) {
          expect(window.id).toMatch(/^\d+$/);
        }
        const { pid } = await provider.launch({
          command: 'cmd.exe',
          args: ['/d', '/c', 'exit', '0'],
        });
        expect(pid).toBeGreaterThan(0);
      } finally {
        provider.close();
      }
    });
  },
);

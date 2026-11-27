import type { DesktopProvider } from '../provider.js';
import { DesktopService, type DesktopServiceOptions } from '../service.js';
import {
  FAKE_DESKTOP_MODES,
  FakeDesktopProvider,
  type FakeDesktopMode,
} from './fake.js';
import { MacosDesktopProvider } from './macos.js';
import { WindowsDesktopProvider } from './windows.js';
import { X11DesktopProvider } from './x11.js';

export { MacosDesktopProvider, toMacosChord } from './macos.js';
export { toWindowsKeyCombo, WindowsDesktopProvider } from './windows.js';
export {
  DEFAULT_VNC_SOCKET_PATH,
  toXdotoolCombo,
  X11DesktopProvider,
} from './x11.js';

export interface DesktopProviderOptions {
  /** Receives desktop hints and helper logs. Defaults to plain stderr. */
  warn?: (message: string) => void;
}

/**
 * The desktop provider for a platform, or none where klex-machine has no
 * desktop support. Linux uses X11 from `DISPLAY` and the VNC socket at
 * `KLEX_MACHINE_VNC_SOCKET`; macOS and Windows use the signed-in user's
 * desktop. What each can actually do is left to `probe()`.
 */
export function createDesktopProvider(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  { warn }: DesktopProviderOptions = {},
): DesktopProvider | undefined {
  const mode = env.KLEX_MACHINE_DESKTOP?.toLowerCase();
  if (mode === 'off') return undefined;
  if (isFakeMode(mode)) return new FakeDesktopProvider(mode, env);
  switch (platform) {
    case 'darwin':
      return new MacosDesktopProvider({ env, ...(warn ? { warn } : {}) });
    case 'linux':
      return new X11DesktopProvider({
        env,
        ...(env.DISPLAY ? { display: env.DISPLAY } : {}),
        ...(env.KLEX_MACHINE_VNC_SOCKET
          ? { vncSocketPath: env.KLEX_MACHINE_VNC_SOCKET }
          : {}),
      });
    case 'win32':
      return new WindowsDesktopProvider({ env, ...(warn ? { warn } : {}) });
    default:
      return undefined;
  }
}

function isFakeMode(mode: string | undefined): mode is FakeDesktopMode {
  return (FAKE_DESKTOP_MODES as readonly (string | undefined)[]).includes(mode);
}

const shared = new Map<string, DesktopService>();

/**
 * The desktop for this process. Set `KLEX_MACHINE_DESKTOP=off` to never offer
 * one. Instances are shared per platform, display and VNC socket so every
 * principal's actions are serialized against one screen.
 */
export function desktopFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  { warn, ...options }: DesktopServiceOptions & DesktopProviderOptions = {},
  platform: NodeJS.Platform = process.platform,
): DesktopService | undefined {
  const key = [
    platform,
    env.KLEX_MACHINE_DESKTOP?.toLowerCase() ?? '',
    env.DISPLAY?.trim() ?? '',
    env.KLEX_MACHINE_VNC_SOCKET ?? '',
  ].join('\0');
  let service = shared.get(key);
  if (!service) {
    const provider = createDesktopProvider(env, platform, {
      ...(warn ? { warn } : {}),
    });
    if (!provider) return undefined;
    service = new DesktopService(provider, options);
    shared.set(key, service);
  }
  return service;
}

import type { DesktopProvider } from '../provider.js';
import { DesktopService, type DesktopServiceOptions } from '../service.js';
import { X11DesktopProvider } from './x11.js';

export {
  DEFAULT_VNC_SOCKET_PATH,
  toXdotoolCombo,
  X11DesktopProvider,
} from './x11.js';

/**
 * The desktop provider for a platform, or none where klex-machine has no
 * desktop support. Linux uses X11 from `DISPLAY` and the VNC socket at
 * `KLEX_MACHINE_VNC_SOCKET`; what it can actually do is left to `probe()`.
 */
export function createDesktopProvider(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DesktopProvider | undefined {
  if (env.KLEX_MACHINE_DESKTOP?.toLowerCase() === 'off') return undefined;
  switch (platform) {
    case 'linux':
      return new X11DesktopProvider({
        env,
        ...(env.DISPLAY ? { display: env.DISPLAY } : {}),
        ...(env.KLEX_MACHINE_VNC_SOCKET
          ? { vncSocketPath: env.KLEX_MACHINE_VNC_SOCKET }
          : {}),
      });
    default:
      return undefined;
  }
}

const shared = new Map<string, DesktopService>();

/**
 * The desktop for this process. Set `KLEX_MACHINE_DESKTOP=off` to never offer
 * one. Instances are shared per platform, display and VNC socket so every
 * principal's actions are serialized against one screen.
 */
export function desktopFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: DesktopServiceOptions = {},
  platform: NodeJS.Platform = process.platform,
): DesktopService | undefined {
  const key = [
    platform,
    env.DISPLAY?.trim() ?? '',
    env.KLEX_MACHINE_VNC_SOCKET ?? '',
  ].join('\0');
  let service = shared.get(key);
  if (!service) {
    const provider = createDesktopProvider(env, platform);
    if (!provider) return undefined;
    service = new DesktopService(provider, options);
    shared.set(key, service);
  }
  return service;
}

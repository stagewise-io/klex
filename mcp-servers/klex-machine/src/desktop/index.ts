import { DesktopService, type DesktopServiceOptions } from './service.js';
import { X11DesktopBackend } from './x11.js';

export type * from './backend.js';
export * from './input-control.js';
export * from './lease.js';
export * from './rfb-filter.js';
export * from './service.js';
export { DESKTOP_SCREEN_RESOURCE_URI, registerDesktopTools } from './tools.js';
export { toXdotoolCombo, X11DesktopBackend } from './x11.js';

const shared = new Map<string, DesktopService>();

/**
 * The desktop for this process, from `DISPLAY`. Set `KLEX_MACHINE_DESKTOP=off`
 * to never advertise desktop tools. Instances are shared per display so every
 * principal's actions are serialized against one screen.
 */
export function desktopFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: DesktopServiceOptions = {},
): DesktopService | undefined {
  if (env.KLEX_MACHINE_DESKTOP?.toLowerCase() === 'off') return undefined;
  const display = env.DISPLAY?.trim();
  if (!display || process.platform !== 'linux') return undefined;
  let service = shared.get(display);
  if (!service) {
    service = new DesktopService(
      new X11DesktopBackend({ display, env }),
      options,
    );
    shared.set(display, service);
  }
  return service;
}

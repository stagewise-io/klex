/**
 * Platform-independent desktop code. Platform providers live in `./platform/`
 * and are chosen only by the process entry points; see
 * test/desktop-boundary.test.ts.
 */
export * from './input-control.js';
export * from './lease.js';
export type * from './provider.js';
export { NO_DESKTOP } from './provider.js';
export * from './rfb-filter.js';
export * from './service.js';
export { DESKTOP_SCREEN_RESOURCE_URI, registerDesktopTools } from './tools.js';

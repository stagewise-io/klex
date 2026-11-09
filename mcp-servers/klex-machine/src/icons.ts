import { Buffer } from 'node:buffer';

import {
  detectMachineDeviceType,
  type MachineDeviceType,
} from './cloud/facts/device-type.js';

const server =
  '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01m5-11h3m-3 11h3"/>';
const shapes = {
  laptop:
    '<rect x="5" y="4" width="14" height="11" rx="1.5"/><path d="M3 18h18l-1.5 2h-15Z"/>',
  desktop:
    '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M12 16v5m-4 0h8"/>',
  server,
  vm: server,
  container:
    '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 9v6m5-6v6m5-6v6"/>',
  unknown:
    '<rect x="4" y="4" width="16" height="13" rx="2"/><path d="M8 21h8"/>',
};

/** Self-contained images: no external requests, HTML, or inherited CSS colors. */
export function machineIcons(deviceType?: MachineDeviceType) {
  return (['light', 'dark'] as const).map((theme) => {
    const color = theme === 'dark' ? '#eeece8' : '#383633';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes[deviceType ?? 'unknown']}</svg>`;
    return {
      src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
      mimeType: 'image/svg+xml',
      sizes: ['any'],
      theme,
    };
  });
}

/** Probe once per process, not per principal or stateless MCP request. */
export function createMachineIconProvider(detect = detectMachineDeviceType) {
  let pending: Promise<ReturnType<typeof machineIcons>> | undefined;
  return () => {
    pending ??= (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, 1000);
      });
      try {
        const deviceType = await Promise.race([
          detect(process.platform, controller.signal),
          timeout,
        ]);
        return machineIcons(deviceType);
      } catch {
        return machineIcons();
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    })();
    return pending;
  };
}

export const detectedMachineIcons = createMachineIconProvider();

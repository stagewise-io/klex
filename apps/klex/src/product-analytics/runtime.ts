/**
 * Coarse host and process readings for `klex_usage_window`.
 *
 * Everything here comes from Node's built-in counters, read once per window.
 * No background sampler, no filesystem access.
 */

import { arch, platform, release } from 'node:os';

const BYTES_PER_MB = 1024 * 1024;
const KB_PER_MB = 1024;

/** Static per process. */
export interface RuntimeInfo {
  platform: string;
  arch: string;
  /** Coarse OS release, see {@link coarseOsRelease}. */
  release: string;
  nodeVersion: string;
}

/** Cumulative process counters at one point in time. */
export interface ResourceSample {
  /** User + system CPU time since process start. */
  cpuMicros: number;
  rssBytes: number;
  heapUsedBytes: number;
  /** Peak RSS since process start (libuv normalizes to KB on all platforms). */
  peakRssKb: number;
  uptimeS: number;
}

/** Resource properties for one window. */
export interface WindowResources {
  cpuAvgPct: number;
  rssMb: number;
  heapUsedMb: number;
  rssPeakMb: number;
  uptimeS: number;
}

/**
 * Kernel major version only (`darwin` 24, `linux` 6). Windows keeps
 * `major.minor.build` because 10 and 11 both report `10.0`; the build
 * number is the only thing that separates them.
 */
export function coarseOsRelease(
  osPlatform: string,
  fullRelease: string,
): string {
  const parts = fullRelease.split(/[.-]/);
  if (osPlatform === 'win32') return parts.slice(0, 3).join('.');
  return parts[0] ?? '';
}

export function readRuntimeInfo(): RuntimeInfo {
  const osPlatform = platform();
  return {
    platform: osPlatform,
    arch: arch(),
    release: coarseOsRelease(osPlatform, release()),
    nodeVersion: process.versions.node,
  };
}

export function sampleResources(): ResourceSample {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  return {
    cpuMicros: cpu.user + cpu.system,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    peakRssKb: process.resourceUsage().maxRSS,
    uptimeS: process.uptime(),
  };
}

/**
 * Derives window values from two samples. CPU is the window average in
 * percent of one core, so multi-threaded work can exceed 100.
 */
export function windowResources(
  previous: ResourceSample,
  current: ResourceSample,
  windowMs: number,
): WindowResources {
  const cpuMicros = Math.max(0, current.cpuMicros - previous.cpuMicros);
  const cpuAvgPct = windowMs > 0 ? (cpuMicros / (windowMs * 1_000)) * 100 : 0;
  return {
    cpuAvgPct: Math.round(cpuAvgPct * 10) / 10,
    rssMb: Math.round(current.rssBytes / BYTES_PER_MB),
    heapUsedMb: Math.round(current.heapUsedBytes / BYTES_PER_MB),
    rssPeakMb: Math.round(current.peakRssKb / KB_PER_MB),
    uptimeS: Math.floor(current.uptimeS),
  };
}

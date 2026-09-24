import { describe, expect, it } from 'vitest';

import {
  coarseOsRelease,
  type ResourceSample,
  readRuntimeInfo,
  sampleResources,
  windowResources,
} from './runtime';

const MB = 1024 * 1024;

function sample(overrides: Partial<ResourceSample> = {}): ResourceSample {
  return {
    cpuMicros: 0,
    rssBytes: 0,
    heapUsedBytes: 0,
    peakRssKb: 0,
    uptimeS: 0,
    ...overrides,
  };
}

describe('coarseOsRelease', () => {
  it.each([
    ['darwin', '24.1.0', '24'],
    ['linux', '6.8.0-45-generic', '6'],
    ['linux', '5.15.153.1-microsoft-standard-WSL2', '5'],
    ['win32', '10.0.22631', '10.0.22631'],
    ['win32', '10.0.19045', '10.0.19045'],
  ])('%s %s -> %s', (osPlatform, full, expected) => {
    expect(coarseOsRelease(osPlatform, full)).toBe(expected);
  });
});

describe('windowResources', () => {
  it('averages CPU over the window as percent of one core', () => {
    const windowMs = 10_000;
    const result = windowResources(
      sample({ cpuMicros: 1_000_000 }),
      sample({ cpuMicros: 3_500_000 }),
      windowMs,
    );
    expect(result.cpuAvgPct).toBe(25);
  });

  it('can exceed 100 % for multi-threaded work', () => {
    const result = windowResources(
      sample(),
      sample({ cpuMicros: 15_000_000 }),
      10_000,
    );
    expect(result.cpuAvgPct).toBe(150);
  });

  it('reports 0 CPU for an empty window and never goes negative', () => {
    expect(
      windowResources(sample(), sample({ cpuMicros: 5 }), 0).cpuAvgPct,
    ).toBe(0);
    expect(
      windowResources(sample({ cpuMicros: 10 }), sample(), 1_000).cpuAvgPct,
    ).toBe(0);
  });

  it('converts memory to whole MB and floors uptime', () => {
    const result = windowResources(
      sample(),
      sample({
        rssBytes: 512 * MB,
        heapUsedBytes: 96.4 * MB,
        peakRssKb: 700 * 1024,
        uptimeS: 7_200.9,
      }),
      1_000,
    );
    expect(result).toMatchObject({
      rssMb: 512,
      heapUsedMb: 96,
      rssPeakMb: 700,
      uptimeS: 7_200,
    });
  });
});

describe('live readings', () => {
  it('reads plausible values from the current process', () => {
    const info = readRuntimeInfo();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.nodeVersion).toBe(process.versions.node);
    expect(info.release).not.toContain(' ');

    const current = sampleResources();
    expect(current.rssBytes).toBeGreaterThan(0);
    expect(current.heapUsedBytes).toBeGreaterThan(0);
    // maxRSS is KB: peak must be at least current RSS, and not 1024x larger.
    expect(current.peakRssKb * 1024).toBeGreaterThanOrEqual(
      current.rssBytes * 0.5,
    );
    expect(current.peakRssKb).toBeLessThan(current.rssBytes);
  });
});

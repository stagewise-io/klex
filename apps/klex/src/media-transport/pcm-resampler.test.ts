import { describe, expect, it } from 'vitest';

import { createPcmResampler } from './pcm-resampler';

function pcm(samples: readonly number[]): Uint8Array {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, sample, true);
  });
  return data;
}

function samples(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Array.from({ length: data.byteLength / 2 }, (_, index) =>
    view.getInt16(index * 2, true),
  );
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe('PCM resampler', () => {
  it('preserves silence and exact long-run sample counts', () => {
    const down = createPcmResampler('48-to-24');
    const up = createPcmResampler('24-to-48');
    expect(samples(down.process(pcm(Array(961).fill(0))))).toEqual(
      Array(480).fill(0),
    );
    expect(samples(up.process(pcm(Array(480).fill(0))))).toHaveLength(960);
  });

  it('produces identical output across arbitrary chunk boundaries', () => {
    const input = Array.from({ length: 997 }, (_, index) =>
      Math.round(20_000 * Math.sin((2 * Math.PI * index) / 31)),
    );
    const whole = createPcmResampler('48-to-24').process(pcm(input));
    const chunked = createPcmResampler('48-to-24');
    const parts = [input.slice(0, 7), input.slice(7, 112), input.slice(112)];
    expect(
      concatenate(parts.map((part) => chunked.process(pcm(part)))),
    ).toEqual(whole);
  });

  it('bounds impulses and handles positive and negative full scale', () => {
    const down = createPcmResampler('48-to-24');
    const output = samples(
      down.process(pcm([32_767, -32_768, ...Array(62).fill(0)])),
    );
    expect(Math.max(...output)).toBeLessThanOrEqual(32_767);
    expect(Math.min(...output)).toBeGreaterThanOrEqual(-32_768);
    expect(output.some((sample) => sample !== 0)).toBe(true);
  });

  it('attenuates content above the output Nyquist limit', () => {
    const amplitude = (frequency: number) => {
      const input = Array.from({ length: 4_800 }, (_, index) =>
        Math.round(
          20_000 * Math.sin((2 * Math.PI * frequency * index) / 48_000),
        ),
      );
      const output = samples(
        createPcmResampler('48-to-24').process(pcm(input)),
      ).slice(40);
      return Math.sqrt(
        output.reduce((sum, sample) => sum + sample * sample, 0) /
          output.length,
      );
    };
    expect(amplitude(3_000)).toBeGreaterThan(10_000);
    expect(amplitude(15_000)).toBeLessThan(2_000);
  });

  it('resets converter history at interruption boundaries', () => {
    const converter = createPcmResampler('24-to-48');
    converter.process(pcm([10_000]));
    converter.reset();
    expect(samples(converter.process(pcm([-10_000])))).toEqual([
      -10_000, -10_000,
    ]);
  });

  it('rejects partial PCM samples and copies output buffers', () => {
    const converter = createPcmResampler('24-to-48');
    expect(() => converter.process(new Uint8Array(1))).toThrow(
      'even byte length',
    );
    const input = pcm([123]);
    const output = converter.process(input);
    input.fill(0);
    expect(samples(output)).toEqual([123, 123]);
  });
});

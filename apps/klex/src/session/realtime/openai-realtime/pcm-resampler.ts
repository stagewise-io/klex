export interface PcmResampler {
  process(data: Uint8Array): Uint8Array;
  reset(): void;
}

const DOWNSAMPLE_FACTOR = 2;
const FIR_TAPS = 31;
const CUTOFF_CYCLES_PER_SAMPLE = 0.22;

class PcmResamplerModule implements PcmResampler {
  private readonly history = new Float64Array(FIR_TAPS);
  private historyIndex = 0;
  private inputCount = 0;
  private previousUpsample = 0;
  private hasPreviousUpsample = false;

  constructor(private readonly direction: '48-to-24' | '24-to-48') {}

  process(data: Uint8Array): Uint8Array {
    if (data.byteLength % 2 !== 0)
      throw new Error('PCM16 data must have an even byte length');
    const samples = decodePcm16(data);
    return encodePcm16(
      this.direction === '48-to-24'
        ? this.downsample(samples)
        : this.upsample(samples),
    );
  }

  reset(): void {
    this.history.fill(0);
    this.historyIndex = 0;
    this.inputCount = 0;
    this.previousUpsample = 0;
    this.hasPreviousUpsample = false;
  }

  private downsample(input: Int16Array): Int16Array {
    const output = new Int16Array(
      Math.floor((this.inputCount + input.length) / DOWNSAMPLE_FACTOR) -
        Math.floor(this.inputCount / DOWNSAMPLE_FACTOR),
    );
    let outputIndex = 0;
    for (const sample of input) {
      this.history[this.historyIndex] = sample;
      this.historyIndex = (this.historyIndex + 1) % FIR_TAPS;
      this.inputCount += 1;
      if (this.inputCount % DOWNSAMPLE_FACTOR === 0) {
        let filtered = 0;
        for (let tap = 0; tap < FIR_TAPS; tap += 1) {
          const index = (this.historyIndex - 1 - tap + FIR_TAPS) % FIR_TAPS;
          filtered += this.history[index]! * LOW_PASS_COEFFICIENTS[tap]!;
        }
        output[outputIndex++] = clampPcm16(filtered);
      }
    }
    return output;
  }

  private upsample(input: Int16Array): Int16Array {
    const output = new Int16Array(input.length * 2);
    let outputIndex = 0;
    for (const sample of input) {
      const previous = this.hasPreviousUpsample
        ? this.previousUpsample
        : sample;
      output[outputIndex++] = clampPcm16((previous + sample) / 2);
      output[outputIndex++] = sample;
      this.previousUpsample = sample;
      this.hasPreviousUpsample = true;
    }
    return output;
  }
}

export function createPcmResampler(
  direction: '48-to-24' | '24-to-48',
): PcmResampler {
  return new PcmResamplerModule(direction);
}

function decodePcm16(data: Uint8Array): Int16Array {
  const result = new Int16Array(data.byteLength / 2);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = 0; index < result.length; index += 1)
    result[index] = view.getInt16(index * 2, true);
  return result;
}

function encodePcm16(samples: Int16Array): Uint8Array {
  const result = new Uint8Array(samples.length * 2);
  const view = new DataView(result.buffer);
  for (let index = 0; index < samples.length; index += 1)
    view.setInt16(index * 2, samples[index]!, true);
  return result;
}

function clampPcm16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

function lowPassCoefficients(): Float64Array {
  const coefficients = new Float64Array(FIR_TAPS);
  const center = (FIR_TAPS - 1) / 2;
  let sum = 0;
  for (let index = 0; index < FIR_TAPS; index += 1) {
    const offset = index - center;
    const sinc =
      offset === 0
        ? 2 * CUTOFF_CYCLES_PER_SAMPLE
        : Math.sin(2 * Math.PI * CUTOFF_CYCLES_PER_SAMPLE * offset) /
          (Math.PI * offset);
    const window =
      0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (FIR_TAPS - 1));
    coefficients[index] = sinc * window;
    sum += coefficients[index]!;
  }
  for (let index = 0; index < coefficients.length; index += 1)
    coefficients[index]! /= sum;
  return coefficients;
}

const LOW_PASS_COEFFICIENTS = lowPassCoefficients();

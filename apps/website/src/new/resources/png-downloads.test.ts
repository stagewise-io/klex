import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogoPng, pngWidths } from './png-downloads';

const drawImage = vi.fn();
const decode = vi.fn();
const png = new Blob(['png'], { type: 'image/png' });
const canvas = {
  width: 0,
  height: 0,
  getContext: vi.fn(() => ({ drawImage })),
  toBlob: vi.fn((callback: (blob: Blob | null) => void) => callback(png)),
};

beforeEach(() => {
  vi.clearAllMocks();
  decode.mockResolvedValue(undefined);
  canvas.getContext.mockReturnValue({ drawImage });
  canvas.toBlob.mockImplementation((callback) => callback(png));
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 332;
      naturalHeight = 123;
      decode = decode;
    },
  );
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
});

afterEach(() => vi.unstubAllGlobals());

describe('browser PNG generation', () => {
  it.each(pngWidths)(
    'renders a wordmark at %i px wide without changing its aspect ratio',
    async (width) => {
      const result = await createLogoPng('/klex-logo-light.svg', width);
      const height = Math.round((width * 123) / 332);
      expect(canvas.width).toBe(width);
      expect(canvas.height).toBe(height);
      expect(drawImage).toHaveBeenCalledWith(
        expect.anything(),
        0,
        0,
        width,
        height,
      );
      expect(canvas.toBlob).toHaveBeenCalledWith(
        expect.any(Function),
        'image/png',
      );
      expect(result).toEqual({
        blob: png,
        filename: `klex-logo-light-${width}x${height}.png`,
      });
    },
  );

  it('exports a square avatar with a descriptive filename', async () => {
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        naturalWidth = 100;
        naturalHeight = 100;
        decode = decode;
      },
    );
    const result = await createLogoPng('/brand/klex-avatar.svg', 1024);
    expect(canvas.height).toBe(1024);
    expect(result.filename).toBe('klex-avatar-1024x1024.png');
  });

  it('rejects unsupported sizes before loading the image', async () => {
    await expect(createLogoPng('/klex-logo-light.svg', 999999)).rejects.toThrow(
      'supported PNG resolution',
    );
    expect(decode).not.toHaveBeenCalled();
  });

  it('propagates image loading errors', async () => {
    decode.mockRejectedValue(new Error('Image unavailable'));
    await expect(createLogoPng('/missing.svg', 256)).rejects.toThrow(
      'Image unavailable',
    );
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('reports canvas encoding failure', async () => {
    canvas.toBlob.mockImplementation((callback) => callback(null));
    await expect(createLogoPng('/klex-logo-light.svg', 256)).rejects.toThrow(
      'could not be generated',
    );
  });
});

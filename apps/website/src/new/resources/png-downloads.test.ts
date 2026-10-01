import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogoPng, mountPngDownloads, pngWidths } from './png-downloads';

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

function pendingImage() {
  let resolve: () => void;
  let reject: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: () => resolve(),
    reject: (error: Error) => reject(error),
  };
}

function downloadControls() {
  const attributes = new Map<string, string>();
  const select = { value: '512' };
  const status = { textContent: '' };
  const controls = {
    querySelector: vi.fn((selector: string) =>
      selector === 'select' ? select : status,
    ),
  };
  // Use a native EventTarget so click dispatch and AbortSignal cleanup are real.
  const button = Object.assign(new EventTarget(), {
    dataset: { pngSource: '/klex-logo-light.svg' },
    disabled: false,
    closest: vi.fn(() => controls),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    click: () => button.dispatchEvent(new Event('click')),
  });
  const link = {
    href: '',
    download: '',
    click: vi.fn(),
    remove: vi.fn(),
  };
  const root = {
    querySelectorAll: vi.fn(() => [button]),
    append: vi.fn(),
  };
  const createObjectURL = vi.fn(() => 'blob:klex-png');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('document', {
    createElement: vi.fn((tag: string) => {
      if (tag === 'canvas') return canvas;
      if (tag === 'a') return link;
      throw new Error(`Unexpected element: ${tag}`);
    }),
  });
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  const dispose = mountPngDownloads(root as unknown as HTMLElement);
  return {
    attributes,
    button,
    status,
    link,
    root,
    createObjectURL,
    revokeObjectURL,
    dispose,
  };
}

describe('mounted PNG downloads', () => {
  beforeEach(() => vi.useFakeTimers());

  it('downloads the selected resolution, restores controls, and revokes its URL', async () => {
    const loading = pendingImage();
    decode.mockReturnValue(loading.promise);
    const controls = downloadControls();
    expect(controls.root.querySelectorAll).toHaveBeenCalledWith(
      '[data-png-source]',
    );
    controls.button.click();
    expect(controls.button.disabled).toBe(true);
    expect(controls.attributes.get('aria-busy')).toBe('true');
    expect(controls.status.textContent).toBe('Generating PNG…');
    controls.button.click();
    expect(decode).toHaveBeenCalledTimes(1);
    loading.resolve();

    await vi.waitFor(() =>
      expect(controls.status.textContent).toBe('PNG download started.'),
    );
    expect(controls.createObjectURL).toHaveBeenCalledWith(png);
    expect(controls.link.href).toBe('blob:klex-png');
    expect(controls.link.download).toBe('klex-logo-light-512x190.png');
    expect(controls.root.append).toHaveBeenCalledWith(controls.link);
    expect(controls.link.click).toHaveBeenCalledOnce();
    expect(controls.link.remove).toHaveBeenCalledOnce();
    expect(controls.button.disabled).toBe(false);
    expect(controls.attributes.has('aria-busy')).toBe(false);
    expect(controls.revokeObjectURL).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(controls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      'blob:klex-png',
    );
    controls.dispose();
  });

  it.each(['loading', 'encoding', 'download'])(
    'restores controls after %s failure',
    async (failure) => {
      const controls = downloadControls();
      if (failure === 'loading')
        decode.mockRejectedValue(new Error('Image unavailable'));
      if (failure === 'encoding')
        canvas.toBlob.mockImplementation((callback) => callback(null));
      if (failure === 'download')
        controls.link.click.mockImplementation(() => {
          throw new Error('Download blocked');
        });
      controls.button.click();
      expect(controls.button.disabled).toBe(true);
      expect(controls.attributes.get('aria-busy')).toBe('true');
      expect(controls.status.textContent).toBe('Generating PNG…');
      await vi.waitFor(() =>
        expect(controls.status.textContent).toBe(
          'PNG export failed. Try again or download the SVG.',
        ),
      );
      expect(controls.button.disabled).toBe(false);
      expect(controls.attributes.has('aria-busy')).toBe(false);
      if (failure === 'download') {
        expect(controls.root.append).toHaveBeenCalledWith(controls.link);
        expect(controls.link.remove).toHaveBeenCalledOnce();
        await vi.runAllTimersAsync();
        expect(controls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
          'blob:klex-png',
        );
      } else {
        expect(controls.root.append).not.toHaveBeenCalled();
        expect(controls.createObjectURL).not.toHaveBeenCalled();
      }
      controls.dispose();
    },
  );

  it.each(['success', 'failure'])(
    'ignores a pending %s after disposal',
    async (outcome) => {
      const loading = pendingImage();
      decode.mockReturnValue(loading.promise);
      const controls = downloadControls();
      controls.button.click();
      controls.dispose();
      if (outcome === 'success') loading.resolve();
      else loading.reject(new Error('Image unavailable'));
      await vi.runAllTimersAsync();
      expect(controls.createObjectURL).not.toHaveBeenCalled();
      expect(controls.root.append).not.toHaveBeenCalled();
      expect(controls.link.click).not.toHaveBeenCalled();
      expect(controls.status.textContent).toBe('Generating PNG…');
      expect(controls.button.disabled).toBe(true);
      expect(controls.attributes.get('aria-busy')).toBe('true');
    },
  );

  it('removes the click handler on disposal', () => {
    const controls = downloadControls();
    controls.dispose();
    controls.button.click();
    expect(decode).not.toHaveBeenCalled();
    expect(controls.button.disabled).toBe(false);
    expect(controls.attributes.has('aria-busy')).toBe(false);
    expect(controls.status.textContent).toBe('');
  });
});

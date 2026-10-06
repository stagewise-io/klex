export const pngWidths = [256, 512, 1024, 2048] as const;

export async function createLogoPng(source: string, width: number) {
  if (!pngWidths.some((option) => option === width)) {
    throw new Error('Choose a supported PNG resolution.');
  }

  const image = new Image();
  image.src = source;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error('The logo could not be loaded.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(
    1,
    Math.round((width * image.naturalHeight) / image.naturalWidth),
  );
  const context = canvas.getContext('2d');
  if (!context) throw new Error('PNG export is unavailable in this browser.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('The PNG could not be generated.'));
    }, 'image/png');
  });

  const basename =
    source
      .split('/')
      .pop()
      ?.replace(/\.svg$/i, '') || 'klex-logo';
  return { blob, filename: `${basename}-${canvas.width}x${canvas.height}.png` };
}

export function mountPngDownloads(root: HTMLElement) {
  const events = new AbortController();
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    '[data-png-source]',
  )) {
    const controls = button.closest('.resource-png-controls');
    const select = controls?.querySelector<HTMLSelectElement>('select');
    const status = controls?.querySelector<HTMLElement>('[role="status"]');
    if (!select || !status) continue;

    button.addEventListener(
      'click',
      async () => {
        if (button.disabled) return;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        status.textContent = 'Generating PNG…';
        try {
          const { blob, filename } = await createLogoPng(
            button.dataset.pngSource ?? '',
            Number(select.value),
          );
          if (events.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          root.append(link);
          try {
            link.click();
            status.textContent = 'PNG download started.';
          } finally {
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        } catch {
          if (!events.signal.aborted)
            status.textContent =
              'PNG export failed. Try again or download the SVG.';
        } finally {
          if (!events.signal.aborted) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
          }
        }
      },
      { signal: events.signal },
    );
  }
  return () => events.abort();
}

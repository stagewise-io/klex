import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { authorizationCommand, LocalBrowserOAuthPresenter } from './presenter';

const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

afterEach(() => {
  stderrWrite.mockClear();
});

afterAll(() => {
  stderrWrite.mockRestore();
});

describe('LocalBrowserOAuthPresenter', () => {
  it('opens the authorization URL in the default browser', async () => {
    const opener = vi.fn(async () => undefined);
    const presenter = new LocalBrowserOAuthPresenter(opener);
    const authorizationUrl = new URL('https://auth.example.com/authorize');

    await presenter.present(authorizationUrl);

    expect(opener).toHaveBeenCalledWith(authorizationUrl.toString());
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('prints an intentional fallback when browser spawning fails', async () => {
    const presenter = new LocalBrowserOAuthPresenter(async () => {
      throw new Error('browser unavailable');
    });
    const authorizationUrl = new URL('https://auth.example.com/authorize');

    await presenter.present(authorizationUrl);

    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining(authorizationUrl.toString()),
    );
  });

  it('prints the fallback when the browser launcher exits unsuccessfully', async () => {
    const presenter = new LocalBrowserOAuthPresenter(async () => {
      throw new Error('Browser launcher exited with status 1');
    });
    const authorizationUrl = new URL('https://auth.example.com/authorize');

    await presenter.present(authorizationUrl);

    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining(authorizationUrl.toString()),
    );
  });

  it('selects the native launcher for each supported platform', () => {
    const url = 'https://auth.example.com/authorize';
    expect(authorizationCommand(url, 'darwin')).toEqual(['open', [url]]);
    expect(authorizationCommand(url, 'win32')).toEqual([
      'rundll32',
      ['url.dll,FileProtocolHandler', url],
    ]);
    expect(authorizationCommand(url, 'linux')).toEqual(['xdg-open', [url]]);
  });
});

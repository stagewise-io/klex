import { spawn } from 'node:child_process';

const BROWSER_LAUNCH_TIMEOUT_MS = 10_000;

export type OpenAuthorizationUrl = (url: string) => Promise<void>;

export function authorizationCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): readonly [command: string, args: readonly string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32')
    return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

function openAuthorizationUrl(url: string): Promise<void> {
  const [command, args] = authorizationCommand(url);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Browser launcher timed out'));
    }, BROWSER_LAUNCH_TIMEOUT_MS);
    timeout.unref();
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Browser launcher exited with status ${code}`));
    });
  });
}

export class LocalBrowserOAuthPresenter {
  public constructor(
    private readonly openUrl: OpenAuthorizationUrl = openAuthorizationUrl,
  ) {}

  public async present(authorizationUrl: URL): Promise<void> {
    try {
      await this.openUrl(authorizationUrl.toString());
    } catch {
      process.stderr.write(
        `Open this URL in a browser to authorize the MCP server:\n${authorizationUrl.toString()}\n`,
      );
    }
  }
}

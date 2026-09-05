import { join } from 'node:path';

import { isNewerReleaseVersion, releaseManifestSchema } from '../release';
import {
  discoverManagedInstallation,
  type ManagedInstallation,
} from './discovery';
import { runImmutableInstaller } from './installer-runner';
import { readLimitedResponse } from './read-limited-response';

const REPOSITORY = 'stagewise-io/klex';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export type UpdateState =
  | { readonly status: 'idle' | 'checking' | 'up-to-date' }
  | { readonly status: 'available'; readonly version: string }
  | {
      readonly status: 'installing';
      readonly message: string;
      readonly version: string;
    }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly version?: string;
    }
  | { readonly status: 'restarting'; readonly version: string };

export interface UpdateManagerOptions {
  readonly checkIntervalMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly installation: ManagedInstallation;
  readonly onRestartRequested: (
    installation: ManagedInstallation,
  ) => Promise<void> | void;
  readonly runInstaller?: typeof runImmutableInstaller;
  readonly validateInstallation?: (
    version: string,
  ) => Promise<ManagedInstallation | null>;
}

export class UpdateManager {
  readonly #options: UpdateManagerOptions;
  readonly #listeners = new Set<(state: UpdateState) => void>();
  #state: UpdateState = { status: 'idle' };
  #checkPromise: Promise<void> | undefined;
  #installController: AbortController | undefined;
  #installPromise: Promise<void> | undefined;
  #interval: NodeJS.Timeout | undefined;
  #checkController: AbortController | undefined;
  #offeredRelease:
    | { readonly gitCommit: string; readonly version: string }
    | undefined;

  constructor(options: UpdateManagerOptions) {
    this.#options = options;
  }

  getState(): UpdateState {
    return this.#state;
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#interval) return;
    void this.check();
    this.#interval = setInterval(
      () => void this.check(),
      this.#options.checkIntervalMs ?? 4 * 60 * 60 * 1000,
    );
    this.#interval.unref();
  }

  stop(): void {
    if (this.#interval) clearInterval(this.#interval);
    this.#interval = undefined;
    this.#checkController?.abort();
  }

  check(): Promise<void> {
    if (this.#checkPromise) return this.#checkPromise;
    if (this.#installPromise) return Promise.resolve();
    this.#checkPromise = this.#performCheck().finally(() => {
      this.#checkPromise = undefined;
    });
    return this.#checkPromise;
  }

  async cancelInstall(): Promise<void> {
    const install = this.#installPromise;
    if (!install) return;
    this.#installController?.abort();
    await install;
  }

  install(): Promise<void> {
    if (this.#installPromise) return this.#installPromise;
    if (this.#state.status !== 'available' && this.#state.status !== 'failed') {
      return Promise.resolve();
    }
    const version = this.#state.version;
    if (!version || this.#offeredRelease?.version !== version)
      return Promise.resolve();
    this.#setState({
      status: 'installing',
      message: 'Preparing update',
      version,
    });
    this.#installPromise = this.#performInstall(version).finally(() => {
      this.#installPromise = undefined;
    });
    return this.#installPromise;
  }

  #setState(state: UpdateState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  async #performCheck(): Promise<void> {
    const previousOffer = this.#offeredRelease;
    if (!previousOffer) this.#setState({ status: 'checking' });
    const controller = new AbortController();
    this.#checkController = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    timeout.unref();
    try {
      const url = manifestUrl(this.#options.installation.channel);
      const response = await (this.#options.fetchImplementation ?? fetch)(url, {
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await readLimitedResponse(
        response,
        MAX_MANIFEST_BYTES,
        'Manifest is too large',
      );
      const manifest = releaseManifestSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      if (
        manifest.channel !== this.#options.installation.channel ||
        !manifest.artifacts.some(
          (artifact) => artifact.target === this.#options.installation.target,
        )
      ) {
        throw new Error('Release manifest does not match this installation');
      }
      if (
        isNewerReleaseVersion(
          manifest.version,
          this.#options.installation.version,
        )
      ) {
        this.#offeredRelease = {
          gitCommit: manifest.gitCommit,
          version: manifest.version,
        };
        this.#setState({ status: 'available', version: manifest.version });
      } else {
        this.#offeredRelease = undefined;
        this.#setState({ status: 'up-to-date' });
      }
    } catch {
      // Version checks are opportunistic. Preserve a valid existing offer when
      // a later poll fails so a temporary outage does not remove the banner.
      if (previousOffer) {
        this.#setState({ status: 'available', version: previousOffer.version });
      } else {
        this.#setState({ status: 'idle' });
      }
    } finally {
      clearTimeout(timeout);
      if (this.#checkController === controller)
        this.#checkController = undefined;
    }
  }

  async #performInstall(version: string): Promise<void> {
    const controller = new AbortController();
    this.#installController = controller;
    try {
      const release = this.#offeredRelease;
      if (!release || release.version !== version) {
        throw new Error('Update metadata is no longer available');
      }
      await (this.#options.runInstaller ?? runImmutableInstaller)({
        gitCommit: release.gitCommit,
        installRoot: this.#options.installation.root,
        platform: process.platform,
        signal: controller.signal,
        version,
        onProgress: (message) =>
          this.#setState({ status: 'installing', message, version }),
      });
      if (controller.signal.aborted) throw new Error('Update cancelled');
      const updatedInstallation = await this.#validateInstallation(version);
      if (controller.signal.aborted) throw new Error('Update cancelled');
      if (!updatedInstallation) {
        throw new Error('Installed update could not be verified');
      }
      this.#setState({ status: 'restarting', version });
      await this.#options.onRestartRequested(updatedInstallation);
    } catch (error) {
      this.#setState({
        status: 'failed',
        message: controller.signal.aborted
          ? 'Update cancelled'
          : error instanceof Error
            ? error.message
            : 'Update failed',
        version,
      });
    } finally {
      if (this.#installController === controller)
        this.#installController = undefined;
    }
  }

  async #validateInstallation(
    version: string,
  ): Promise<ManagedInstallation | null> {
    if (this.#options.validateInstallation) {
      return this.#options.validateInstallation(version);
    }
    const executableName = process.platform === 'win32' ? 'klex.exe' : 'klex';
    const installation = await discoverManagedInstallation({
      executablePath: join(
        this.#options.installation.root,
        'versions',
        version,
        executableName,
      ),
      platform: process.platform,
      target: this.#options.installation.target,
      version,
    });
    if (
      installation?.root !== this.#options.installation.root ||
      installation.channel !== this.#options.installation.channel
    ) {
      return null;
    }
    return installation;
  }
}

function manifestUrl(channel: 'stable' | 'nightly'): string {
  return `https://github.com/${REPOSITORY}/releases/download/channel-${channel}/release-manifest.json`;
}

import { open, statfs } from 'node:fs/promises';
import * as os from 'node:os';

export const MACHINE_FACTS_HEADER = 'x-klex-machine-facts';
export const MAX_MACHINE_FACTS_HEADER_BYTES = 4096;
const MAX_OS_RELEASE_BYTES = 16_384;

export interface MachineFacts {
  v: 1;
  machineVersion: string;
  os: { platform: string; arch: string; release?: string; name?: string };
  cpu: { model?: string; logicalCores?: number };
  memory: { totalBytes?: number };
  host?: {
    hostname?: string;
    workspacePath?: string;
    workspaceVolumeTotalBytes?: number;
  };
}

export interface MachineFactsOptions {
  cwd: string;
  omitHostDetails: boolean;
  version: string;
}

export interface MachineFactsProbes {
  platform(): string;
  arch(): string;
  release(): string;
  cpuModel(): string | undefined;
  availableParallelism(): number;
  totalmem(): number;
  hostname(): string;
  readOsRelease(path: string, signal: AbortSignal): Promise<string>;
  volumeBytes(path: string): Promise<bigint>;
}

async function readOsRelease(
  path: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const file = await open(path, 'r');
  try {
    signal.throwIfAborted();
    const buffer = Buffer.alloc(MAX_OS_RELEASE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    if (bytesRead > MAX_OS_RELEASE_BYTES)
      throw new Error('OS release file too large');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

const defaultProbes: MachineFactsProbes = {
  platform: os.platform,
  arch: os.arch,
  release: os.release,
  cpuModel: () => os.cpus().find((cpu) => cpu.model.trim())?.model,
  availableParallelism: os.availableParallelism,
  totalmem: os.totalmem,
  hostname: os.hostname,
  readOsRelease,
  volumeBytes: async (path) => {
    const volume = await statfs(path, { bigint: true });
    return volume.bsize * volume.blocks;
  },
};

function text(value: string | undefined): string | undefined {
  return value?.trim().slice(0, 256).trim() || undefined;
}

function positiveInteger(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function probe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Parse os-release as inert data, never shell syntax. */
export function prettyOsName(source: string): string | undefined {
  if (Buffer.byteLength(source) > MAX_OS_RELEASE_BYTES) return undefined;
  const raw = source.match(/^PRETTY_NAME=(.*)$/m)?.[1]?.trim();
  if (!raw) return undefined;
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) return undefined;
    return text(raw.slice(1, -1).replace(/\\(["\\$`])/g, '$1'));
  }
  if (raw.startsWith("'")) {
    return raw.endsWith("'") && raw.length >= 2
      ? text(raw.slice(1, -1))
      : undefined;
  }
  return text(raw);
}

export interface MachineFactsCollector {
  collect(): Promise<MachineFacts>;
}

class MachineFactsCollectorModule implements MachineFactsCollector {
  constructor(
    private readonly options: MachineFactsOptions,
    private readonly probes: MachineFactsProbes,
  ) {}

  async collect(): Promise<MachineFacts> {
    const p = this.probes;
    const facts: MachineFacts = {
      v: 1,
      machineVersion: text(this.options.version) ?? 'unknown',
      os: { platform: p.platform(), arch: p.arch() },
      cpu: {},
      memory: {},
    };
    facts.os.release = probe(() => text(p.release()));
    facts.cpu.model = probe(() => text(p.cpuModel()));
    facts.cpu.logicalCores = probe(() =>
      positiveInteger(p.availableParallelism()),
    );
    facts.memory.totalBytes = probe(() => positiveInteger(p.totalmem()));
    if (!this.options.omitHostDetails) {
      const path = this.options.cwd;
      facts.host = {
        hostname: probe(() => text(p.hostname())),
        workspacePath:
          path.length > 0 && path.length <= 1024 ? path : undefined,
      };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve();
      }, 1000);
    });
    const signal = controller.signal;
    const name = async () => {
      try {
        if (facts.os.platform !== 'linux') {
          facts.os.name =
            facts.os.platform === 'darwin'
              ? 'macOS'
              : facts.os.platform === 'win32'
                ? 'Windows'
                : undefined;
          return;
        }
        for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
          if (signal.aborted) return;
          const source = await p
            .readOsRelease(path, signal)
            .catch(() => undefined);
          if (signal.aborted) return;
          const value = source === undefined ? undefined : prettyOsName(source);
          if (value) {
            facts.os.name = value;
            return;
          }
        }
      } catch {
        /* Optional probe. */
      }
    };
    const disk = async () => {
      if (!facts.host) return;
      try {
        const value = await p.volumeBytes(this.options.cwd);
        if (
          !signal.aborted &&
          value > 0n &&
          value <= BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          facts.host.workspaceVolumeTotalBytes = Number(value);
        }
      } catch {
        /* statfs is not supported on every filesystem/platform. */
      }
    };
    try {
      await Promise.race([Promise.all([name(), disk()]), timeout]);
      // No pending probe can mutate the returned document after the budget expires.
      return structuredClone(facts);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}

export function createMachineFactsCollector(
  options: MachineFactsOptions,
  probes: MachineFactsProbes = defaultProbes,
): MachineFactsCollector {
  return new MachineFactsCollectorModule(options, probes);
}

export function encodeMachineFactsHeader(
  facts: MachineFacts,
): string | undefined {
  const header = Buffer.from(JSON.stringify(facts), 'utf8').toString(
    'base64url',
  );
  return header.length <= MAX_MACHINE_FACTS_HEADER_BYTES ? header : undefined;
}

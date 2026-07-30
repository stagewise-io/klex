#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { AppPackagerConfig, SigningMode } from '../config/index.js';
import { packageApp } from '../package-app/index.js';
import { signExecutable, verifyExecutable } from '../signing/index.js';

export interface CliIO {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIO: CliIO = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

export async function runCli(
  arguments_: readonly string[],
  io: CliIO = defaultIO,
): Promise<number> {
  try {
    const [command, ...commandArguments] = arguments_;
    if (command === 'package') {
      await runPackageCommand(commandArguments, io);
    } else if (command === 'sign') {
      await runSignCommand(commandArguments, io);
    } else if (command === 'verify') {
      await runVerifyCommand(commandArguments, io);
    } else {
      throw new Error('Usage: app-packager <package|sign|verify> [options]');
    }
    return 0;
  } catch (error) {
    io.stderr(formatError(error));
    return 1;
  }
}

async function runPackageCommand(
  arguments_: readonly string[],
  io: CliIO,
): Promise<void> {
  const { values } = parseArgs({
    args: [...arguments_],
    options: { config: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.config) {
    throw new Error('package requires --config <path>');
  }
  const configPath = resolve(values.config);
  const config = await loadConfig(configPath);
  io.stdout(`Packaging ${config.name}...`);
  const artifact = await packageApp(config, {
    baseDirectory: dirname(configPath),
  });
  io.stdout(formatResult(artifact));
}

async function runSignCommand(
  arguments_: readonly string[],
  io: CliIO,
): Promise<void> {
  const { values } = parseArgs({
    args: [...arguments_],
    options: {
      file: { type: 'string' },
      mode: { type: 'string', default: 'optional' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.file) throw new Error('sign requires --file <path>');
  const mode = parseSigningMode(values.mode);
  const file = resolve(values.file);
  io.stdout(`Signing ${file}...`);
  const result = await signExecutable({ file, mode });
  io.stdout(formatResult({ file, ...result }));
}

async function runVerifyCommand(
  arguments_: readonly string[],
  io: CliIO,
): Promise<void> {
  const { values } = parseArgs({
    args: [...arguments_],
    options: { file: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.file) throw new Error('verify requires --file <path>');
  const file = resolve(values.file);
  io.stdout(`Verifying ${file}...`);
  const result = await verifyExecutable({ file });
  io.stdout(formatResult({ file, ...result }));
}

async function loadConfig(path: string): Promise<AppPackagerConfig> {
  const module = (await import(pathToFileURL(path).href)) as {
    readonly default?: unknown;
  };
  if (!module.default || typeof module.default !== 'object') {
    throw new Error('App packager config must have a default object export');
  }
  return module.default as AppPackagerConfig;
}

function parseSigningMode(value: string | undefined): SigningMode {
  if (value !== 'optional' && value !== 'required') {
    throw new Error('--mode must be optional or required');
  }
  return value;
}

function formatResult(value: object): string {
  return JSON.stringify(value, undefined, 2);
}

function formatError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    if (!messages.includes(current.message)) messages.push(current.message);
    current = current.cause;
  }
  if (messages.length === 0) messages.push(String(error));
  return `app-packager: ${messages.join(': ')}`;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createConfig } from './config';

const required = {
  GATEWAY_URL: 'wss://gateway.example.com/environment',
  GATEWAY_TOKEN: 'secret',
};

describe('createConfig', () => {
  it('loads required values and defaults', () => {
    const config = createConfig(required);

    expect(config.gatewayUrl.href).toBe(
      'wss://gateway.example.com/environment',
    );
    expect(config.gatewayToken).toBe('secret');
    expect(config.windowsMcpCommand).toBe('uvx');
    expect(config.windowsMcpLaunchMode).toBe('uvx');
    expect(config.windowsMcpPort).toBe(8123);
    expect(config.logLevel).toBe('INFO');
  });

  it('loads valid overrides', () => {
    const config = createConfig({
      ...required,
      WINDOWS_MCP_COMMAND: 'C:\\tools\\uvx.exe',
      WINDOWS_MCP_LAUNCH_MODE: 'executable',
      WINDOWS_MCP_PORT: '9000',
      LOG_LEVEL: 'debug',
    });

    expect(config.windowsMcpCommand).toBe('C:\\tools\\uvx.exe');
    expect(config.windowsMcpLaunchMode).toBe('executable');
    expect(config.windowsMcpPort).toBe(9000);
    expect(config.logLevel).toBe('DEBUG');
  });

  it('loads packaged JSON config and resolves its executable path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'windows-use-config-'));
    const path = join(directory, 'windows-use.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        gatewayUrl: 'wss://gateway.example.com/environment',
        gatewayToken: 'secret',
        windowsMcpCommand: 'windows-mcp/windows-mcp.exe',
      }),
    );

    const config = createConfig({}, path);

    expect(config.windowsMcpCommand).toBe(
      join(directory, 'windows-mcp/windows-mcp.exe'),
    );
    expect(config.windowsMcpLaunchMode).toBe('executable');
  });

  it.each(['GATEWAY_URL', 'GATEWAY_TOKEN'] as const)(
    'rejects missing %s',
    (name) => {
      expect(() => createConfig({ ...required, [name]: undefined })).toThrow(
        `${name} is required`,
      );
    },
  );

  it('rejects unsupported gateway protocols', () => {
    expect(() =>
      createConfig({ ...required, GATEWAY_URL: 'https://gateway.example.com' }),
    ).toThrow('GATEWAY_URL must use ws: or wss:');
  });

  it.each(['0', '65536', '1.5', 'invalid'])(
    'rejects invalid port %s',
    (port) => {
      expect(() =>
        createConfig({ ...required, WINDOWS_MCP_PORT: port }),
      ).toThrow('WINDOWS_MCP_PORT must be an integer from 1 to 65535');
    },
  );

  it('rejects an empty command', () => {
    expect(() =>
      createConfig({ ...required, WINDOWS_MCP_COMMAND: '  ' }),
    ).toThrow('WINDOWS_MCP_COMMAND must not be empty');
  });

  it('rejects an invalid launch mode', () => {
    expect(() =>
      createConfig({ ...required, WINDOWS_MCP_LAUNCH_MODE: 'automatic' }),
    ).toThrow('WINDOWS_MCP_LAUNCH_MODE must be executable or uvx');
  });

  it('rejects an invalid log level', () => {
    expect(() => createConfig({ ...required, LOG_LEVEL: 'verbose' })).toThrow(
      'LOG_LEVEL must be',
    );
  });
});

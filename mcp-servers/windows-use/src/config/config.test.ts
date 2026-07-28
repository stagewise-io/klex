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
    expect(config.windowsMcpPort).toBe(8123);
    expect(config.logLevel).toBe('INFO');
  });

  it('loads valid overrides', () => {
    const config = createConfig({
      ...required,
      WINDOWS_MCP_COMMAND: 'C:\\tools\\uvx.exe',
      WINDOWS_MCP_PORT: '9000',
      LOG_LEVEL: 'debug',
    });

    expect(config.windowsMcpCommand).toBe('C:\\tools\\uvx.exe');
    expect(config.windowsMcpPort).toBe(9000);
    expect(config.logLevel).toBe('DEBUG');
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

  it('rejects an invalid log level', () => {
    expect(() => createConfig({ ...required, LOG_LEVEL: 'verbose' })).toThrow(
      'LOG_LEVEL must be',
    );
  });
});

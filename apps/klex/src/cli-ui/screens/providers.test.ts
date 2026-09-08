import { describe, expect, it } from 'vitest';

import {
  activeSetupFields,
  isConfiguredSecretMarker,
  parseSetupValue,
  setupFieldsFromSchema,
} from './providers';

describe('provider setup fields', () => {
  it('applies conditional visibility from prior values', () => {
    const fields = [
      {
        key: 'authMode',
        label: 'Authentication',
        kind: 'select' as const,
        options: [
          { label: 'API key', value: 'key' },
          { label: 'Default credentials', value: 'default' },
        ],
      },
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'secret' as const,
        condition: { field: 'authMode', equals: 'key' },
      },
    ];

    expect(activeSetupFields(fields, { authMode: 'default' })).toEqual([
      fields[0],
    ]);
    expect(activeSetupFields(fields, { authMode: 'key' })).toEqual(fields);
  });

  it('derives discriminated setup fields from schema alternatives', () => {
    const fields = setupFieldsFromSchema({
      type: 'google-vertex',
      displayName: 'Vertex',
      description: 'Vertex provider',
      capabilities: {
        modelDiscovery: false,
        connectivityTest: true,
        customModels: true,
      },
      settingsSchema: {
        oneOf: [
          {
            properties: {
              authMode: { const: 'adc', title: 'Authentication' },
              project: { type: 'string', title: 'Project' },
            },
            required: ['authMode', 'project'],
          },
          {
            properties: {
              authMode: { const: 'api-key', title: 'Authentication' },
              project: { type: 'string', title: 'Project' },
              apiKey: { type: 'string', title: 'API key', format: 'password' },
            },
            required: ['authMode', 'project', 'apiKey'],
          },
        ],
      },
    });

    expect(fields).toEqual([
      expect.objectContaining({
        key: 'authMode',
        kind: 'select',
        options: [
          { label: 'ADC', value: 'adc' },
          { label: 'API key', value: 'api-key' },
        ],
      }),
      expect.objectContaining({ key: 'project' }),
      expect.objectContaining({
        key: 'apiKey',
        required: true,
        condition: { field: 'authMode', equals: 'api-key' },
      }),
    ]);
  });

  it('normalizes number, boolean, and key-value inputs', () => {
    expect(
      parseSetupValue({ key: 'port', label: 'Port', kind: 'number' }, '8080'),
    ).toBe(8080);
    expect(
      parseSetupValue(
        { key: 'enabled', label: 'Enabled', kind: 'boolean' },
        'true',
      ),
    ).toBe(true);
    expect(
      parseSetupValue(
        { key: 'headers', label: 'Headers', kind: 'key-value' },
        'Authorization=Bearer token, X-Tenant=main',
      ),
    ).toEqual({ Authorization: 'Bearer token', 'X-Tenant': 'main' });
    expect(
      parseSetupValue(
        { key: 'headers', label: 'Headers', kind: 'secret-key-value' },
        'Accept=text/plain, application/json',
      ),
    ).toEqual({ Accept: 'text/plain, application/json' });
    expect(
      parseSetupValue(
        { key: 'headers', label: 'Headers', kind: 'secret-key-value' },
        '{"Authorization":"Bearer ${env:TOKEN}","X-Tenant":"main,backup"}',
      ),
    ).toEqual({
      Authorization: 'Bearer ${env:TOKEN}',
      'X-Tenant': 'main,backup',
    });
  });

  it('recognizes only exact configured-secret marker objects', () => {
    expect(isConfiguredSecretMarker({ configured: true })).toBe(true);
    expect(isConfiguredSecretMarker({ configured: false })).toBe(true);
    expect(
      isConfiguredSecretMarker({ configured: true, Authorization: 'value' }),
    ).toBe(false);
    expect(isConfiguredSecretMarker({ configured: 'yes' })).toBe(false);
  });

  it('rejects malformed typed values', () => {
    expect(() =>
      parseSetupValue({ key: 'port', label: 'Port', kind: 'number' }, 'abc'),
    ).toThrow('Port must be a number');
    expect(() =>
      parseSetupValue(
        { key: 'headers', label: 'Headers', kind: 'key-value' },
        'missing-value',
      ),
    ).toThrow('Headers must use key=value pairs');
    expect(() =>
      parseSetupValue(
        { key: 'headers', label: 'Headers', kind: 'secret-key-value' },
        '{"Authorization":true}',
      ),
    ).toThrow('Headers must be a JSON object of string values');
    expect(() =>
      parseSetupValue(
        { key: 'headers', label: 'Headers', kind: 'secret-key-value' },
        ' =value',
      ),
    ).toThrow('Headers must use key=value or JSON object syntax');
  });
});

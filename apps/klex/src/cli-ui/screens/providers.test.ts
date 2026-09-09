import { describe, expect, it } from 'vitest';

import { scrollbarTrack } from '../components/scrollable-box';
import {
  activeSetupFields,
  isConfiguredSecretMarker,
  nextProviderInstanceId,
  parseSetupValue,
  setupFieldsFromSchema,
} from './providers';

describe('provider instance ID', () => {
  it('uses the provider type and skips existing IDs', () => {
    expect(nextProviderInstanceId('openai', [])).toBe('openai');
    expect(nextProviderInstanceId('openai', ['openai'])).toBe('openai-2');
    expect(
      nextProviderInstanceId('openai', ['openai', 'openai-2', 'other']),
    ).toBe('openai-3');
  });
});

describe('scrollable box scrollbar', () => {
  it('hides the track when every item is visible', () => {
    expect(scrollbarTrack(10, 0)).toBe('');
  });

  it('moves a proportional thumb from the top to the bottom', () => {
    expect(scrollbarTrack(12, 0).split('\n')).toEqual([
      '█',
      '█',
      '█',
      '█',
      '█',
      '█',
      '█',
      '█',
      '│',
      '│',
    ]);
    expect(scrollbarTrack(12, 11).split('\n')).toEqual([
      '│',
      '│',
      '█',
      '█',
      '█',
      '█',
      '█',
      '█',
      '█',
      '█',
    ]);
  });
});

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

  it('omits provider-managed settings', () => {
    const fields = setupFieldsFromSchema({
      type: 'openrouter',
      displayName: 'OpenRouter',
      description: 'Gateway',
      capabilities: {
        modelDiscovery: true,
        connectivityTest: true,
        customModels: true,
      },
      settingsSchema: {
        type: 'object',
        properties: {
          apiKey: { type: 'string' },
          httpReferer: { type: 'string', readOnly: true },
          appName: { type: 'string', readOnly: true },
        },
      },
    });

    expect(fields.map(({ key }) => key)).toEqual(['apiKey']);
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
        '{"Authorization":"Bearer $' + '{env:TOKEN}","X-Tenant":"main,backup"}',
      ),
    ).toEqual({
      Authorization: 'Bearer $' + '{env:TOKEN}',
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

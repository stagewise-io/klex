import { describe, expect, it } from 'vitest';

import {
  createAgentResourceAttributes,
  createIdentityResourceAttributes,
  createTelemetryResource,
  createTelemetryResourceAttributes,
  type IdentityTelemetryLevel,
} from './telemetry-resource';

const options = {
  serviceName: 'klex',
  serviceNamespace: 'stagewise',
  serviceVersion: '1.2.3',
  serviceInstanceId: 'instance',
};

describe('telemetry resource', () => {
  it('builds the shared service and runtime identity', () => {
    const attributes = createTelemetryResourceAttributes(options);
    expect(createTelemetryResource(options).attributes).toEqual(attributes);
    expect(attributes).toMatchObject({
      'service.name': 'klex',
      'service.namespace': 'stagewise',
      'service.version': '1.2.3',
      'service.instance.id': 'instance',
      'host.arch': expect.any(String),
      'os.type': expect.any(String),
      'os.version': expect.any(String),
      'process.runtime.name': 'nodejs',
    });
  });

  it('excludes private host and dynamic configuration identity', () => {
    const attributes = createTelemetryResourceAttributes(options);
    for (const key of [
      'host.name',
      'user.name',
      'host.id',
      'provider.id',
      'model.id',
      'available.memory',
    ]) {
      expect(attributes).not.toHaveProperty(key);
    }
  });

  it('builds the agent identity separately from the shared resource', () => {
    expect(
      createAgentResourceAttributes({
        agentName: '  Klex  ',
        dataDirectory: '/agents/klex',
      }),
    ).toEqual({
      'klex.agent.name': 'Klex',
      'klex.agent.data_dir': '/agents/klex',
    });
    expect(
      createAgentResourceAttributes({ agentName: ' ', dataDirectory: '/a' }),
    ).toEqual({ 'klex.agent.data_dir': '/a' });
    expect(createTelemetryResourceAttributes(options)).not.toHaveProperty(
      'klex.agent.name',
    );
  });

  it('gates identity attributes by telemetry level', () => {
    let level: IdentityTelemetryLevel = 'no';
    let clientId: string | null = 'client-1';
    const identity = createIdentityResourceAttributes({
      getLevel: () => level,
      agent: { agentName: 'Klex', dataDirectory: '/Users/someone/agent' },
      getCloudClientId: () => clientId,
    });

    expect(identity()).toEqual({});
    level = 'basic';
    expect(identity()).toEqual({ 'klex.cloud.client_id': 'client-1' });
    level = 'advanced';
    expect(identity()).toEqual({
      'klex.cloud.client_id': 'client-1',
      'klex.agent.name': 'Klex',
    });
    level = 'debug';
    expect(identity()).toEqual({
      'klex.cloud.client_id': 'client-1',
      'klex.agent.name': 'Klex',
      'klex.agent.data_dir': '/Users/someone/agent',
    });
    clientId = null;
    level = 'basic';
    expect(identity()).toEqual({});
  });
});

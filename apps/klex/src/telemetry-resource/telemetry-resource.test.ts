import { describe, expect, it } from 'vitest';

import {
  createTelemetryResource,
  createTelemetryResourceAttributes,
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
      'process.runtime.name': 'nodejs',
    });
  });

  it('excludes host and dynamic configuration identity', () => {
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
});

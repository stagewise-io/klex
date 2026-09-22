import { resources } from '@opentelemetry/sdk-node';

export interface TelemetryResourceOptions {
  serviceName: string;
  serviceNamespace: string;
  serviceVersion: string;
  serviceInstanceId: string;
}

export function createTelemetryResourceAttributes(
  options: TelemetryResourceOptions,
): Record<string, string> {
  return {
    'service.name': options.serviceName,
    'service.namespace': options.serviceNamespace,
    'service.version': options.serviceVersion,
    'service.instance.id': options.serviceInstanceId,
    'process.runtime.name': 'nodejs',
    'process.runtime.version': process.version,
  };
}

export function createTelemetryResource(options: TelemetryResourceOptions) {
  return createTelemetryResourceFromAttributes(
    createTelemetryResourceAttributes(options),
  );
}

export function createTelemetryResourceFromAttributes(
  attributes: Record<string, string>,
) {
  return resources.resourceFromAttributes(attributes);
}

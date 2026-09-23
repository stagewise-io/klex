import { arch, type as osType, release } from 'node:os';

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
    'host.arch': normalizeResourceValue(arch()),
    'os.type': normalizeResourceValue(osType()),
    'os.version': normalizeResourceValue(release().split('-')[0] ?? release()),
    'process.runtime.name': 'nodejs',
    'process.runtime.version': process.version,
  };
}

export interface AgentResourceOptions {
  /** Configured `officialName` of the agent. */
  agentName: string;
  /** Absolute path of the agent data directory. */
  dataDirectory: string;
}

const MAX_AGENT_NAME_LENGTH = 128;

/** Trimmed, length-bounded agent name; empty when none is configured. */
export function normalizeAgentName(agentName: string): string {
  return Array.from(agentName.trim()).slice(0, MAX_AGENT_NAME_LENGTH).join('');
}

/**
 * Agent identity resource attributes for per-agent dashboards. They are
 * identifying: the agent name is user-chosen, and the data directory usually
 * contains the OS username. Exporters gate them by level (see
 * `createIdentityResourceAttributes`).
 */
export function createAgentResourceAttributes(
  options: AgentResourceOptions,
): Record<string, string> {
  const agentName = normalizeAgentName(options.agentName);
  return {
    ...(agentName ? { 'klex.agent.name': agentName } : {}),
    'klex.agent.data_dir': options.dataDirectory,
  };
}

export type IdentityTelemetryLevel = 'no' | 'basic' | 'advanced' | 'debug';

export interface IdentityResourceOptions {
  /** Current telemetry level; evaluated on every call. */
  getLevel(): IdentityTelemetryLevel;
  agent: AgentResourceOptions;
  /** Enrolled Klex Cloud client id, or null while not enrolled. */
  getCloudClientId(): string | null | undefined;
}

/**
 * Returns a supplier for level-gated identity resource attributes shared by
 * traces, metrics, and logs:
 *
 * - `basic` and above: `klex.cloud.client_id` (opaque, server-assigned id of
 *   the enrolled cloud client; absent while not enrolled)
 * - `advanced` and above: `klex.agent.name` (user-chosen display name)
 * - `debug` only: `klex.agent.data_dir` (absolute path; usually contains the
 *   OS username)
 *
 * At `no` the supplier returns no attributes.
 */
export function createIdentityResourceAttributes(
  options: IdentityResourceOptions,
): () => Record<string, string> {
  const { 'klex.agent.name': agentName, 'klex.agent.data_dir': dataDirectory } =
    createAgentResourceAttributes(options.agent);
  return () => {
    const level = options.getLevel();
    if (level === 'no') return {};
    const clientId = options.getCloudClientId();
    return {
      ...(clientId ? { 'klex.cloud.client_id': clientId } : {}),
      ...(level !== 'basic' && agentName
        ? { 'klex.agent.name': agentName }
        : {}),
      ...(level === 'debug' && dataDirectory
        ? { 'klex.agent.data_dir': dataDirectory }
        : {}),
    };
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

function normalizeResourceValue(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return normalized.slice(0, 64) || 'unknown';
}

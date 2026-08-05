import type { RootLogger } from '@stagewise/logger';

import type { ResolvedRealtimeProvider } from '@/config';
import type { Mcp } from '@/mcp';
import {
  createMediaTransportConnectorRegistry,
  type MediaTransportConnector,
  type MediaTransportConnectorRegistry,
  type RealtimeProcessorFactory,
} from '@/media-transport';
import {
  createLiveKitRoomMediaTransportConnector,
  loadLiveKitSdk,
} from '@/media-transport/livekit-room';

import { createOpenAIRealtimeProcessorFactory } from './openai-realtime';
import {
  createRealtimeSessionCoordinator,
  type RealtimeSessionCoordinator,
} from './realtime';

export interface RealtimeMediaRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeMediaRuntimeDependencies {
  logging: RootLogger;
  mcp: Mcp;
  provider?: ResolvedRealtimeProvider;
  connector?: MediaTransportConnector;
  createConnector?: () => MediaTransportConnector;
  createCoordinator?: (
    connector: MediaTransportConnector,
  ) => RealtimeSessionCoordinator;
}

class RealtimeMediaRuntimeModule implements RealtimeMediaRuntime {
  private connector: MediaTransportConnector | undefined;
  private coordinator: RealtimeSessionCoordinator | undefined;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly deps: RealtimeMediaRuntimeDependencies) {}

  start(): Promise<void> {
    if (!this.deps.provider) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.closePromise)
      return Promise.reject(new Error('Realtime media runtime is closed'));
    this.startPromise = (async () => {
      const connector =
        this.deps.connector ??
        this.deps.createConnector?.() ??
        createProductionMediaTransportConnectorRegistry();
      this.connector = connector;
      const coordinator =
        this.deps.createCoordinator?.(connector) ??
        createRealtimeSessionCoordinator({
          logging: this.deps.logging,
          mcp: this.deps.mcp,
          mediaTransportConnector: connector,
          processorFactory: this.createProcessorFactory(),
        });
      this.coordinator = coordinator;
      try {
        await coordinator.start();
      } catch (error) {
        await connector.close();
        this.connector = undefined;
        this.coordinator = undefined;
        throw error;
      }
    })();
    return this.startPromise;
  }

  private createProcessorFactory(): RealtimeProcessorFactory {
    const provider = this.deps.provider;
    if (!provider) throw new Error('Realtime provider is required');
    switch (provider.kind) {
      case 'openai-realtime':
        return createOpenAIRealtimeProcessorFactory({
          logging: this.deps.logging,
          config: provider.config,
        });
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      await this.coordinator?.close();
      await this.connector?.close();
      this.coordinator = undefined;
      this.connector = undefined;
    })();
    return this.closePromise;
  }
}

export function createRealtimeMediaRuntime(
  deps: RealtimeMediaRuntimeDependencies,
): RealtimeMediaRuntime {
  return new RealtimeMediaRuntimeModule(deps);
}

export function createProductionMediaTransportConnectorRegistry(): MediaTransportConnectorRegistry {
  return createMediaTransportConnectorRegistry([
    {
      profile: 'livekit-room',
      create: () =>
        createLiveKitRoomMediaTransportConnector({ loadSdk: loadLiveKitSdk }),
    },
  ]);
}

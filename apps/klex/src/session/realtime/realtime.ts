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
} from './session-coordinator';

export interface Realtime {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeDependencies {
  logging: RootLogger;
  mcp: Mcp;
  provider: ResolvedRealtimeProvider;
  /**
   * Transfers lifecycle ownership to the realtime module. The caller must not
   * close or reuse the connector after passing it to `createRealtime`.
   */
  ownedConnector: MediaTransportConnector;
  createCoordinator?: (
    connector: MediaTransportConnector,
  ) => RealtimeSessionCoordinator;
}

class RealtimeModule implements Realtime {
  private connector: MediaTransportConnector | undefined;
  private coordinator: RealtimeSessionCoordinator | undefined;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly deps: RealtimeDependencies) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.closePromise)
      return Promise.reject(new Error('Realtime module is closed'));
    this.startPromise = (async () => {
      const connector = this.deps.ownedConnector;
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
    switch (this.deps.provider.kind) {
      case 'openai-realtime':
        return createOpenAIRealtimeProcessorFactory({
          logging: this.deps.logging,
          config: this.deps.provider.config,
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

export function createRealtime(deps: RealtimeDependencies): Realtime {
  return new RealtimeModule(deps);
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

import type { RootLogger } from '@stagewise/logger';

import type { ResolvedOpenAIRealtimeConfig } from '@/config';
import type { Mcp } from '@/mcp';
import type { RealtimeAudioProcessorFactory } from '@/media-transport';
import {
  createLiveKitRoomMediaTransportConnector,
  type LiveKitRoomMediaTransportConnector,
  loadLiveKitSdk,
} from '@/media-transport/livekit-room';
import { createLoopbackProcessorFactory } from '@/media-transport/loopback';

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
  mode: 'disabled' | 'loopback' | 'openai-realtime';
  openAI?: ResolvedOpenAIRealtimeConfig;
  createConnector?: () => LiveKitRoomMediaTransportConnector;
  createCoordinator?: (
    connector: LiveKitRoomMediaTransportConnector,
  ) => RealtimeSessionCoordinator;
}

class RealtimeMediaRuntimeModule implements RealtimeMediaRuntime {
  private connector: LiveKitRoomMediaTransportConnector | undefined;
  private coordinator: RealtimeSessionCoordinator | undefined;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly deps: RealtimeMediaRuntimeDependencies) {}

  start(): Promise<void> {
    if (this.deps.mode === 'disabled') return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.closePromise)
      return Promise.reject(new Error('Realtime media runtime is closed'));
    this.startPromise = (async () => {
      if (this.deps.mode === 'openai-realtime' && !this.deps.openAI)
        throw new Error('OpenAI realtime configuration is required');
      const connector =
        this.deps.createConnector?.() ??
        createLiveKitRoomMediaTransportConnector({ loadSdk: loadLiveKitSdk });
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

  private createProcessorFactory(): RealtimeAudioProcessorFactory {
    if (this.deps.mode === 'loopback') return createLoopbackProcessorFactory();
    if (!this.deps.openAI)
      throw new Error('OpenAI realtime configuration is required');
    return createOpenAIRealtimeProcessorFactory({
      logging: this.deps.logging,
      config: this.deps.openAI,
    });
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

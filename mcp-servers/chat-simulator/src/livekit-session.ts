import { AccessToken } from 'livekit-server-sdk';

import type { AcceptRealtimeMediaSessionResult } from '@stagewise/mcp-extension-realtime-media';

export interface LiveKitSessionConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export interface LiveKitSessionIssuer {
  issueKlexTransport(
    sessionId: string,
  ): Promise<AcceptRealtimeMediaSessionResult>;
  issueBrowserTransport(
    sessionId: string,
  ): Promise<AcceptRealtimeMediaSessionResult>;
}

export function loadLiveKitSessionConfig(
  env: NodeJS.ProcessEnv,
): LiveKitSessionConfig | undefined {
  const url = env.LIVEKIT_URL;
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  if (!url && !apiKey && !apiSecret) return undefined;
  if (!url || !apiKey || !apiSecret) {
    throw new Error(
      'LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together',
    );
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('LIVEKIT_URL must use ws: or wss:');
  }
  return { url, apiKey, apiSecret };
}

class LiveKitSessionIssuerModule implements LiveKitSessionIssuer {
  constructor(private readonly config: LiveKitSessionConfig) {}

  issueKlexTransport(
    sessionId: string,
  ): Promise<AcceptRealtimeMediaSessionResult> {
    return this.issue(sessionId, `klex-${sessionId}`);
  }

  issueBrowserTransport(
    sessionId: string,
  ): Promise<AcceptRealtimeMediaSessionResult> {
    return this.issue(sessionId, `browser-${sessionId}`);
  }

  private async issue(
    sessionId: string,
    identity: string,
  ): Promise<AcceptRealtimeMediaSessionResult> {
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity,
      ttl: '10m',
    });
    token.addGrant({
      room: `klex-realtime-${sessionId}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    return {
      transport: {
        profile: 'livekit-room',
        url: this.config.url,
        token: await token.toJwt(),
      },
    };
  }
}

export function createLiveKitSessionIssuer(
  config: LiveKitSessionConfig,
): LiveKitSessionIssuer {
  return new LiveKitSessionIssuerModule(config);
}

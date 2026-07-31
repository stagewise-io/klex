import type {
  EnvironmentToProxyFrame,
  ProxyToEnvironmentFrame,
} from '../protocol/index.js';

export type Unsubscribe = () => void;

/**
 * An authenticated, ordered connection from the proxy to one environment.
 *
 * Implementations own the physical transport. They must preserve frame order,
 * reject sends that cannot be accepted, and stop emitting frames after close.
 * Reconnection and replay are intentionally outside this contract.
 */
export interface EnvironmentConnection {
  send(frame: ProxyToEnvironmentFrame): Promise<void>;
  onFrame(handler: (frame: EnvironmentToProxyFrame) => void): Unsubscribe;
  onClose(handler: (cause?: Error) => void): Unsubscribe;
  close(): Promise<void>;
}

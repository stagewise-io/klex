import type {
  EnvironmentToGatewayFrame,
  GatewayToEnvironmentFrame,
} from '../protocol/index.js';

export type Unsubscribe = () => void;

/**
 * An authenticated, ordered connection from the gateway to one environment.
 *
 * Implementations own the physical transport. They must preserve frame order,
 * reject sends that cannot be accepted, and stop emitting frames after close.
 * Reconnection and replay are intentionally outside this contract.
 */
export interface EnvironmentConnection {
  send(frame: GatewayToEnvironmentFrame): Promise<void>;
  onFrame(handler: (frame: EnvironmentToGatewayFrame) => void): Unsubscribe;
  onClose(handler: (cause?: Error) => void): Unsubscribe;
  close(): Promise<void>;
}

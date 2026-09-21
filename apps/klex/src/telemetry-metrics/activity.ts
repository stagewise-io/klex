let active = false;
let activeLeases = 0;
let queuedUpdates = 0;
let queueOverflows = 0;
let overflowRecorder: (() => void) | null = null;
let realtimeSessions = 0;
interface ActivityStateProvider {
  getLeaseCount?: () => number;
  getQueueDepth?: () => number;
  getRealtimeSessionCount?: () => number;
}

const activityProviders = new Map<symbol, ActivityStateProvider>();

export function setRealtimeSessionCount(count: number): void {
  if (active) realtimeSessions = Math.max(0, count);
}

export function getRealtimeSessionCount(): number {
  return realtimeSessions;
}

export function setQueueOverflowRecorder(recorder: (() => void) | null): void {
  overflowRecorder = recorder;
}

export function registerActivityStateProviders(
  providers: ActivityStateProvider,
): () => void {
  const id = Symbol('activity-provider');
  activityProviders.set(id, providers);
  return () => activityProviders.delete(id);
}

function sumProviders(key: keyof ActivityStateProvider): number {
  let total = 0;
  for (const provider of activityProviders.values()) {
    total += Math.max(0, provider[key]?.() ?? 0);
  }
  return total;
}

export function setTelemetryActivityEnabled(enabled: boolean): void {
  active = enabled;
  if (enabled) {
    activeLeases = sumProviders('getLeaseCount');
    queuedUpdates = sumProviders('getQueueDepth');
    realtimeSessions = sumProviders('getRealtimeSessionCount');
    return;
  }
  if (!enabled) {
    activeLeases = 0;
    queuedUpdates = 0;
    queueOverflows = 0;
    realtimeSessions = 0;
  }
}

export function interactionLeaseAcquired(): void {
  if (active) activeLeases += 1;
}

export function interactionLeaseReleased(): void {
  if (active) activeLeases = Math.max(0, activeLeases - 1);
}

export function interactionUpdateEnqueued(): void {
  if (active) {
    queuedUpdates += 1;
  }
}

export function interactionUpdateRemoved(count = 1): void {
  if (active) queuedUpdates = Math.max(0, queuedUpdates - count);
}

export function interactionQueueOverflowed(): void {
  if (active) {
    queueOverflows += 1;
    overflowRecorder?.();
  }
}

export function getInteractionTelemetry(): Readonly<{
  activeLeases: number;
  queuedUpdates: number;
  queueOverflows: number;
}> {
  return { activeLeases, queuedUpdates, queueOverflows };
}

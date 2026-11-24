import { describe, expect, it } from 'vitest';

import {
  boundConversationIdLength,
  CONVERSATION_IDLE_GAP_MS,
  createConversationEpochTracker,
  isBackgroundHousekeepingExtension,
  MAX_CONVERSATION_ID_LENGTH,
  MAX_GENERATIONS_PER_CONVERSATION,
} from './conversation-epoch';
import { exportedConversationId } from './telemetry';

describe('ConversationEpochTracker', () => {
  it('uses the initial epoch id until a rollover or checkpoint occurs', () => {
    const tracker = createConversationEpochTracker({
      initialEpochId: 'boot-0001',
      now: () => 1_000,
    });

    expect(tracker.currentEpochId()).toBe('boot-0001');
    expect(tracker.beginGeneration()).toBe('boot-0001');
    expect(tracker.beginGeneration()).toBe('boot-0001');
    // Pure read does not mutate generation counts.
    expect(tracker.currentEpochId()).toBe('boot-0001');
  });

  it('rotates on generation count cap and keeps each rollover suffix distinct', () => {
    let seq = 0;
    const tracker = createConversationEpochTracker({
      initialEpochId: 'boot-1',
      maxGenerations: 3,
      idleGapMs: 60_000,
      now: () => 10_000,
      createSuffix: () => `r${++seq}`,
    });

    expect(tracker.beginGeneration()).toBe('boot-1');
    expect(tracker.beginGeneration()).toBe('boot-1');
    expect(tracker.beginGeneration()).toBe('boot-1');
    // 4th generation exceeds cap of 3 -> rolls over.
    expect(tracker.beginGeneration()).toBe('boot-1:r1');
    expect(tracker.beginGeneration()).toBe('boot-1:r1');
    expect(tracker.beginGeneration()).toBe('boot-1:r1');
    // 7th generation -> second distinct rollover.
    expect(tracker.beginGeneration()).toBe('boot-1:r2');
    expect(tracker.currentEpochId()).toBe('boot-1:r2');
  });

  it('rotates when the idle gap between generations reaches idleGapMs', () => {
    let now = 1_000;
    let seq = 0;
    const tracker = createConversationEpochTracker({
      initialEpochId: 'boot-idle',
      maxGenerations: 100,
      idleGapMs: 30_000,
      now: () => now,
      createSuffix: () => `idle${++seq}`,
    });

    expect(tracker.beginGeneration()).toBe('boot-idle');
    now += 29_999;
    expect(tracker.beginGeneration()).toBe('boot-idle');
    now += 30_000;
    expect(tracker.beginGeneration()).toBe('boot-idle:idle1');
    now += 30_000;
    expect(tracker.beginGeneration()).toBe('boot-idle:idle2');
  });

  it('rotates immediately to the new checkpoint header id and resets counters', () => {
    let now = 1_000;
    let seq = 0;
    const tracker = createConversationEpochTracker({
      initialEpochId: 'boot-1',
      maxGenerations: 2,
      idleGapMs: 30_000,
      now: () => now,
      createSuffix: () => `r${++seq}`,
    });

    expect(tracker.beginGeneration()).toBe('boot-1');
    expect(tracker.beginGeneration()).toBe('boot-1');
    expect(tracker.beginGeneration()).toBe('boot-1:r1');

    expect(tracker.onCheckpointApplied('cp-uuid-2')).toBe('cp-uuid-2');
    expect(tracker.currentEpochId()).toBe('cp-uuid-2');

    // Idle time before checkpoint does not trigger rollover on the fresh epoch.
    now += 1_000_000;
    expect(tracker.beginGeneration()).toBe('cp-uuid-2');
    expect(tracker.beginGeneration()).toBe('cp-uuid-2');
    expect(tracker.beginGeneration()).toBe('cp-uuid-2:r2');
  });

  it('continues a restored checkpoint epoch across a quick restart and honors the remaining budget', () => {
    const now = 100_000;
    let seq = 0;
    const tracker = createConversationEpochTracker({
      initialEpochId: 'boot-restart',
      maxGenerations: 5,
      idleGapMs: 60_000,
      now: () => now,
      createSuffix: () => `r${++seq}`,
    });

    const restored = tracker.restoreFromWindow({
      checkpointId: 'cp-restored',
      restoredGenerations: 3,
      lastActivityAt: now - 10_000,
    });
    expect(restored).toBe('cp-restored');

    // 2 remaining generations fit in the restored epoch (3 + 2 = 5).
    expect(tracker.beginGeneration()).toBe('cp-restored');
    expect(tracker.beginGeneration()).toBe('cp-restored');
    // Next generation rolls over.
    expect(tracker.beginGeneration()).toBe('cp-restored:r1');
  });

  it('rolls over immediately when a restored checkpoint already hit the generation cap', () => {
    const now = 100_000;
    const tracker = createConversationEpochTracker({
      initialEpochId: 'boot-restart',
      maxGenerations: 5,
      idleGapMs: 60_000,
      now: () => now,
      createSuffix: () => 'rolled',
    });

    const restored = tracker.restoreFromWindow({
      checkpointId: 'cp-full',
      restoredGenerations: 5,
      lastActivityAt: now - 1_000,
    });
    expect(restored).toBe('cp-full:rolled');
    expect(tracker.beginGeneration()).toBe('cp-full:rolled');
  });

  it('rolls over immediately when a restored checkpoint was idle longer than idleGapMs', () => {
    const now = 1_000_000;
    const tracker = createConversationEpochTracker({
      initialEpochId: 'boot-restart',
      maxGenerations: 100,
      idleGapMs: 60_000,
      now: () => now,
      createSuffix: () => 'after-idle',
    });

    const restored = tracker.restoreFromWindow({
      checkpointId: 'cp-stale',
      restoredGenerations: 2,
      lastActivityAt: now - 60_000,
    });
    expect(restored).toBe('cp-stale:after-idle');
    expect(tracker.beginGeneration()).toBe('cp-stale:after-idle');
  });

  it('keeps the fresh per-boot epoch when restoring a window without a checkpoint', () => {
    const tracker = createConversationEpochTracker({
      initialEpochId: 'boot-fresh',
      maxGenerations: 5,
      idleGapMs: 60_000,
      now: () => 50_000,
    });

    const restored = tracker.restoreFromWindow({
      restoredGenerations: 4,
      lastActivityAt: 49_000,
    });
    expect(restored).toBe('boot-fresh');
  });

  it('uses safe defaults well below Sigil crash thresholds', () => {
    expect(MAX_GENERATIONS_PER_CONVERSATION).toBe(100);
    expect(CONVERSATION_IDLE_GAP_MS).toBe(45 * 60 * 1_000);
    expect(MAX_CONVERSATION_ID_LENGTH).toBe(255);
  });
});

describe('exportedConversationId and length bounding', () => {
  it('formats default and child conversation ids with optional epochs under 255 chars', () => {
    const agentId = '1e5a39a1-1cb6-476d-b0ac-c0da20f9b0c7';
    const checkpointId = '7c3f8a12-1234-4567-89ab-cdef01234567';

    const defaultScoped = exportedConversationId(
      'default',
      agentId,
      `${checkpointId}:a1b2c3d4`,
    );
    expect(defaultScoped).toBe(`default:${agentId}:${checkpointId}:a1b2c3d4`);
    expect(defaultScoped.length).toBeLessThan(MAX_CONVERSATION_ID_LENGTH);

    expect(exportedConversationId('default', null, 'ep-1')).toBe(
      'default:ep-1',
    );
    expect(exportedConversationId('child-uuid', agentId, 'ep-1')).toBe(
      'child-uuid:ep-1',
    );
    expect(exportedConversationId('child-uuid', agentId)).toBe('child-uuid');
  });

  it('deterministically caps conversation ids exceeding 255 chars without losing epoch entropy', () => {
    const longAgent = 'a'.repeat(240);
    const id1 = exportedConversationId('default', longAgent, 'epoch-1');
    const id2 = exportedConversationId('default', longAgent, 'epoch-2');

    expect(id1.length).toBe(MAX_CONVERSATION_ID_LENGTH);
    expect(id2.length).toBe(MAX_CONVERSATION_ID_LENGTH);
    expect(id1).not.toBe(id2);
    expect(id1).toBe(boundConversationIdLength(`default:${longAgent}:epoch-1`));
  });
});

describe('isBackgroundHousekeepingExtension', () => {
  it('identifies background housekeeping extensions', () => {
    expect(
      isBackgroundHousekeepingExtension('io.stagewise/context-compaction'),
    ).toBe(true);
    expect(isBackgroundHousekeepingExtension('context-compaction')).toBe(true);
    expect(
      isBackgroundHousekeepingExtension('io.stagewise/episode-summary'),
    ).toBe(true);
    expect(isBackgroundHousekeepingExtension('episode-summary')).toBe(true);
    expect(isBackgroundHousekeepingExtension('core:instinct-classifier')).toBe(
      true,
    );
  });

  it('keeps user-facing and media-helper extensions eligible for recording', () => {
    expect(isBackgroundHousekeepingExtension('vision')).toBe(false);
    expect(
      isBackgroundHousekeepingExtension('io.stagewise/image-input-optimizer'),
    ).toBe(false);
    expect(
      isBackgroundHousekeepingExtension('io.stagewise/audio-input-optimizer'),
    ).toBe(false);
    expect(isBackgroundHousekeepingExtension(null)).toBe(false);
    expect(isBackgroundHousekeepingExtension(undefined)).toBe(false);
  });
});

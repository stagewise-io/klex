import { randomUUID } from 'node:crypto';
import { access, rename } from 'node:fs/promises';
import { join } from 'node:path';

import {
  initializeSqliteStore,
  inspectSqliteStore,
  migrateSqliteStore,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';
import { createContextCompactionExtForPurpose } from '@/session/chat/extensions/context-compaction';
import type { ExtensionDeps } from '@/session/chat/extensions/extension-api';
import { createNameLoaderExt } from '@/session/chat/extensions/name-loader';
import { createSoulExt } from '@/session/chat/extensions/soul';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { LINES_FORMAT_PROMPT } from '@/session/chat/utils/history-view';
import { getExtensionIdentifier } from '@/session/chat/utils/tracing';
import { SessionInboxUrgency } from '@/session/inbox';
import type { ChildSessionHandle } from '@/session/types';

import { EpisodicMarkdownStore } from './markdown-store';
import { isMemoryResultMessage, wrapMemoryResult } from './memory-result';
import {
  DEFAULT_MEMORY_RETRIEVAL_CONFIG,
  type MemoryRetrievalConfig,
  type RecallInput,
  recallFingerprint,
  recallInputSchema,
  renderRecall,
  type SurfacedMemory,
} from './retrieval';
import retrievalPrompt from './retrieval-prompt.md';
import {
  createRetrievalToolsExt,
  type RetrievalToolsConfig,
} from './retrieval-tools';
import {
  EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
  EpisodicSearchIndex,
} from './search-index';

const RETRIEVAL_RECOVERY_DELAY_MS = 1_000;
const MAX_SURFACED_FINGERPRINTS = 64;

interface CoordinatorDeps
  extends Pick<
    ExtensionDeps,
    | 'config'
    | 'createChildSession'
    | 'getDataDir'
    | 'getHistory'
    | 'inbox'
    | 'logger'
  > {}

export type RecallRejectionReason = 'attempt-limit' | 'queue-full';

/** Thrown by {@link MemoryRetrievalCoordinator.remember} for expected refusals. */
export class RecallRejectedError extends Error {
  constructor(readonly reason: RecallRejectionReason) {
    super(
      reason === 'attempt-limit'
        ? 'Memory retrieval attempt limit reached for this task'
        : 'Memory retrieval queue is full',
    );
    this.name = 'RecallRejectedError';
  }
}

export interface MemoryRetrievalCoordinator {
  /**
   * Prepares the search index and the retrieval child. Never throws:
   * transient failures are retried in the background, permanent ones leave
   * the coordinator unavailable so recalls fail fast.
   */
  start(): Promise<void>;
  /**
   * Triggers a recall in the retrieval child. Fire-and-forget: the child
   * alone decides what reaches the main session, including "no memory".
   * Buffered while the child is unavailable; throws a plain `Error` when
   * retrieval failed permanently.
   */
  remember(input: RecallInput): void;
  /**
   * Streams a rendered main-session observation into the retrieval child.
   * Fire-and-forget; the child inbox coalesces bursts. Returns `false` only
   * when the child is temporarily unavailable, so the caller can retry the
   * same delta later instead of losing it.
   */
  observe(input: { text: string }): boolean;
  /** Main-session turn state; decides the urgency of proactive memory. */
  setMainTurnActive(active: boolean): void;
  close(): Promise<void>;
  introspect(): Record<string, unknown>;
}

class MemoryRetrievalCoordinatorImpl implements MemoryRetrievalCoordinator {
  private readonly config: MemoryRetrievalConfig;
  /** Recalls waiting for an available child. */
  private readonly buffered: RecallInput[] = [];
  private child: ChildSessionHandle | null = null;
  private index: EpisodicSearchIndex | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryDelayMs = RETRIEVAL_RECOVERY_DELAY_MS;
  private recovering: Promise<void> | null = null;
  private started = false;
  private closed = false;
  private available = false;
  /** Set on unrecoverable index failure; retrieval stays off. */
  private broken: Error | null = null;
  private attemptTaskKey: string | null = null;
  private readonly attempts = new Map<string, number>();
  private mainTurnActive = false;
  private nextRecallId = 0;
  /** Recall id -> time until which surfaces may answer it. */
  private readonly openRecalls = new Map<string, number>();
  private readonly surfacedFingerprints = new Set<string>();
  private recallsSent = 0;
  private observationsSent = 0;
  private recallSurfaced = 0;
  private proactiveSurfaced = 0;
  private proactiveDeduped = 0;

  constructor(
    private readonly deps: CoordinatorDeps,
    config?: Partial<MemoryRetrievalConfig>,
  ) {
    this.config = {
      ...DEFAULT_MEMORY_RETRIEVAL_CONFIG,
      ...config,
    };
  }

  async start(): Promise<void> {
    if (this.closed || this.started) return;
    this.started = true;
    await this.recover();
  }

  remember(input: RecallInput): void {
    const parsed = recallInputSchema.parse(input);
    if (this.broken) throw new Error('Memory retrieval is unavailable');
    this.resetAttemptsIfTaskChanged();
    const fingerprint = recallFingerprint(parsed);
    const attempts = this.attempts.get(fingerprint) ?? 0;
    if (attempts >= this.config.maxRecallAttemptsPerMainTask) {
      throw new RecallRejectedError('attempt-limit');
    }
    const child = this.liveChild();
    if (!child && this.buffered.length >= this.config.maxBufferedRecalls) {
      throw new RecallRejectedError('queue-full');
    }
    this.attempts.set(fingerprint, attempts + 1);
    if (child) {
      this.sendRecall(child, parsed);
    } else {
      this.buffered.push(parsed);
      this.deps.logger.debug('Memory recall buffered — child unavailable');
    }
  }

  observe(input: { text: string }): boolean {
    if (this.closed || this.broken || !this.config.proactiveEnabled) {
      return true;
    }
    const text = input.text.trim();
    if (!text) return true;
    const child = this.liveChild();
    if (!child) {
      this.deps.logger.debug('Memory observation deferred — child unavailable');
      return false;
    }
    this.sendToChild(child, `<observation>\n${text}\n</observation>`);
    this.observationsSent += 1;
    this.deps.logger.debug(
      { characters: text.length },
      'Memory observation sent to retrieval child',
    );
    return true;
  }

  setMainTurnActive(active: boolean): void {
    this.mainTurnActive = active;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.buffered.length = 0;
    this.attempts.clear();
    this.openRecalls.clear();
    this.surfacedFingerprints.clear();
    const child = this.child;
    this.child = null;
    let closeTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      child?.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, 2_000);
      }),
    ]);
    clearTimeout(closeTimer);
    await this.index?.close().catch(() => undefined);
    this.index = null;
    this.available = false;
  }

  introspect(): Record<string, unknown> {
    return {
      childSessionId: this.child?.sessionId ?? null,
      available: this.available,
      broken: this.broken !== null,
      bufferedRecalls: this.buffered.length,
      openRecalls: this.openRecalls.size,
      indexedStatus: this.index?.getStatus() ?? 'unstarted',
      recallsSent: this.recallsSent,
      observationsSent: this.observationsSent,
      recallSurfaced: this.recallSurfaced,
      proactiveSurfaced: this.proactiveSurfaced,
      proactiveDeduped: this.proactiveDeduped,
    };
  }

  /**
   * Returns the child when it can accept input. A terminated child is
   * dropped and replaced in the background.
   */
  private liveChild(): ChildSessionHandle | null {
    if (this.closed || !this.available || !this.child) return null;
    if (this.child.getSessionInfo().status !== 'terminated') return this.child;
    this.deps.logger.warn(
      { retrievalSessionId: this.child.sessionId },
      'Memory retrieval child terminated — replacing it',
    );
    const stale = this.child;
    this.child = null;
    this.available = false;
    void stale.close().catch(() => undefined);
    void this.recover();
    return null;
  }

  private sendRecall(child: ChildSessionHandle, input: RecallInput): void {
    this.nextRecallId += 1;
    const recallId = `r${this.nextRecallId}`;
    this.pruneOpenRecalls();
    this.openRecalls.set(
      recallId,
      Date.now() + this.config.recallAnswerWindowMs,
    );
    this.sendToChild(child, renderRecall(input, recallId));
    this.recallsSent += 1;
    this.deps.logger.debug(
      { recallId },
      'Memory recall sent to retrieval child',
    );
  }

  private pruneOpenRecalls(): void {
    const now = Date.now();
    for (const [recallId, until] of this.openRecalls) {
      if (until <= now) this.openRecalls.delete(recallId);
    }
  }

  private sendToChild(child: ChildSessionHandle, text: string): void {
    child.inbox.sendMessage(
      {
        id: randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text }],
      },
      SessionInboxUrgency.Default,
    );
  }

  private flushBuffered(): void {
    const child = this.liveChild();
    if (!child) return;
    for (const input of this.buffered.splice(0)) this.sendRecall(child, input);
  }

  private handleSurface(memory: SurfacedMemory): void {
    if (this.closed) return;
    this.pruneOpenRecalls();
    const answersRecall =
      memory.recallId !== undefined && this.openRecalls.has(memory.recallId);
    if (memory.recallId !== undefined && !answersRecall) {
      this.deps.logger.debug(
        { recallId: memory.recallId },
        'Surfaced memory cites no open recall — treating it as proactive',
      );
    }
    const fingerprint = [memory.scope, memory.memory]
      .map((value) => value.trim().replace(/\s+/gu, ' '))
      .join('|')
      .toLocaleLowerCase('en-US');
    if (answersRecall) {
      this.recallSurfaced += 1;
    } else if (this.surfacedFingerprints.has(fingerprint)) {
      this.proactiveDeduped += 1;
      this.deps.logger.debug('Proactive memory skipped as duplicate');
      return;
    } else {
      this.proactiveSurfaced += 1;
    }
    this.surfacedFingerprints.delete(fingerprint);
    this.surfacedFingerprints.add(fingerprint);
    while (this.surfacedFingerprints.size > MAX_SURFACED_FINGERPRINTS) {
      const oldest = this.surfacedFingerprints.values().next().value;
      if (oldest === undefined) break;
      this.surfacedFingerprints.delete(oldest);
    }
    const urgency =
      answersRecall || this.mainTurnActive
        ? SessionInboxUrgency.Default
        : SessionInboxUrgency.Deferrable;
    this.deliverToMain(renderSurfacedMemory(memory), urgency);
    this.deps.logger.debug(
      { answersRecall, urgency },
      'Surfaced memory delivered to main session',
    );
  }

  /**
   * The only path from memory into the main session. Wraps every text in a
   * `<memory>` block; callers pass raw memory text.
   */
  private deliverToMain(text: string, urgency: SessionInboxUrgency): void {
    try {
      this.deps.inbox.sendMessage(
        {
          id: randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: wrapMemoryResult(text) }],
        } as ExtendedUIMessage,
        urgency,
      );
    } catch (error) {
      this.deps.logger.debug({ error }, 'Memory could not be delivered');
    }
  }

  /** Single-flight: prepares the index if needed, then the child. */
  private recover(): Promise<void> {
    this.recovering ??= this.tryRecover().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  private async tryRecover(): Promise<void> {
    if (this.closed || this.broken || this.child) return;
    try {
      await this.ensureIndex();
      const child = await this.createChild();
      if (this.closed) {
        await child.close().catch(() => undefined);
        return;
      }
      this.child = child;
      this.available = true;
      this.recoveryDelayMs = RETRIEVAL_RECOVERY_DELAY_MS;
      this.flushBuffered();
    } catch (error) {
      if (this.closed) return;
      if (isPermanentIndexError(error)) {
        this.markBroken(error as Error);
        return;
      }
      this.deps.logger.warn(
        { error, retryInMs: this.recoveryDelayMs },
        'Memory retrieval unavailable — retrying, recalls are buffered',
      );
      this.scheduleRecovery();
    }
  }

  private async ensureIndex(): Promise<void> {
    if (this.index) return;
    const dataDir = this.deps.getDataDir(true);
    const databasePath = join(dataDir, 'episodic-search.sqlite');
    await prepareSearchIndexStore(databasePath, dataDir, this.deps.logger);
    const store = new EpisodicMarkdownStore(join(dataDir, 'episodic'));
    const index = new EpisodicSearchIndex(databasePath, store);
    try {
      await index.start();
    } catch (error) {
      await index.close().catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      await index.close().catch(() => undefined);
      return;
    }
    this.index = index;
  }

  /**
   * Turns retrieval off for the session. Recalls already acknowledged with
   * "Recalling..." get one explicit answer instead of silence.
   */
  private markBroken(error: Error): void {
    this.broken = error;
    this.available = false;
    const pending = this.buffered.splice(0).length;
    this.deps.logger.error(
      { error, pendingRecalls: pending },
      'Memory retrieval disabled — search index cannot be opened',
    );
    if (pending > 0) {
      this.deliverToMain(
        "I can't remember anything right now — my memory is unavailable.",
        SessionInboxUrgency.Default,
      );
    }
  }

  private resetAttemptsIfTaskChanged(): void {
    const latestUser = [...this.deps.getHistory()]
      .reverse()
      .find(
        (message) => message.role === 'user' && !isMemoryResultMessage(message),
      );
    const taskKey = latestUser?.id ?? 'empty-task';
    if (this.attemptTaskKey !== taskKey) {
      this.attemptTaskKey = taskKey;
      this.attempts.clear();
    }
  }

  private scheduleRecovery(): void {
    if (this.closed || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.recover();
    }, this.recoveryDelayMs);
    this.recoveryDelayMs = Math.min(this.recoveryDelayMs * 2, 30_000);
  }

  private createChild(): Promise<ChildSessionHandle> {
    const memoryModels = this.deps.config.getModelSelection('memory');
    const modelPurpose = memoryModels.length > 0 ? 'memory' : ('chat' as const);
    if (modelPurpose === 'chat') {
      this.deps.logger.info(
        { modelPurpose },
        'No memory models configured — memory retrieval falling back to chat models',
      );
    }
    const index = this.index;
    if (!index) throw new Error('Memory retrieval index is not initialized');
    const options: RetrievalToolsConfig = {
      index,
      retrieval: this.config,
      onSurface: (memory) => this.handleSurface(memory),
    };
    return this.deps.createChildSession({
      name: 'memory-retrieval',
      extensionIdentifier: getExtensionIdentifier() ?? 'memory',
      extensions: [
        createNameLoaderExt,
        createSoulExt,
        createContextCompactionExtForPurpose(modelPurpose),
        createRetrievalToolsExt(options),
      ],
      basePrompt: `${retrievalPrompt.trimEnd()}\n\n${LINES_FORMAT_PROMPT}`,
      modelPurpose,
    });
  }
}

/** A store written by a newer schema; retrying cannot help. */
function isPermanentIndexError(error: unknown): boolean {
  return error instanceof Error && /schema=\d+/u.test(error.message);
}

async function prepareSearchIndexStore(
  databasePath: string,
  dataDir: string,
  logger: Pick<CoordinatorDeps['logger'], 'warn'>,
): Promise<void> {
  try {
    const inspection = await inspectSqliteStore(
      databasePath,
      EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
      dataDir,
    );
    if (!inspection) {
      await initializeSqliteStore(
        databasePath,
        EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
        KLEX_VERSION,
      );
      return;
    }
    await migrateSqliteStore(
      databasePath,
      EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
      inspection.metadata,
      KLEX_VERSION,
      inspection.legacy,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /schema=\d+/u.test(message) ||
      /permission|access denied/iu.test(message)
    ) {
      throw error;
    }
    const quarantinePath = await quarantineSearchIndex(databasePath);
    logger.warn(
      { error, quarantinePath },
      'Rebuilding episodic search cache after recoverable failure',
    );
    await initializeSqliteStore(
      databasePath,
      EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
      KLEX_VERSION,
    );
  }
}

async function quarantineSearchIndex(databasePath: string): Promise<string> {
  try {
    await access(databasePath);
  } catch {
    return `${databasePath} (missing)`;
  }
  const quarantinePath = `${databasePath}.corrupt-${Date.now()}`;
  await rename(databasePath, quarantinePath);
  for (const suffix of ['-wal', '-shm']) {
    await rename(
      `${databasePath}${suffix}`,
      `${quarantinePath}${suffix}`,
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  return quarantinePath;
}

function renderSurfacedMemory(memory: SurfacedMemory): string {
  const lines = [`[${memory.scope}] ${memory.memory}`];
  if (memory.followUps.length > 0) {
    lines.push(
      `Follow-ups I could recall: ${memory.followUps.map((q) => `"${q}"`).join(' · ')}`,
    );
  }
  return lines.join('\n');
}

export function createMemoryRetrievalCoordinator(
  deps: CoordinatorDeps,
  config?: Partial<MemoryRetrievalConfig>,
): MemoryRetrievalCoordinator {
  return new MemoryRetrievalCoordinatorImpl(deps, config);
}

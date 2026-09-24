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
  start(): Promise<void>;
  /**
   * Triggers a recall in the retrieval child. Fire-and-forget: the child
   * alone decides what reaches the main session, including "no memory".
   * Buffered while the child is unavailable.
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
  private closed = false;
  private available = false;
  private attemptTaskKey: string | null = null;
  private readonly attempts = new Map<string, number>();
  private mainTurnActive = false;
  /** Surfaces before this time answer a recall. */
  private recallAnswerUntil = 0;
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
    if (this.closed || this.index) return;
    const dataDir = this.deps.getDataDir(true);
    const databasePath = join(dataDir, 'episodic-search.sqlite');
    await prepareSearchIndexStore(databasePath, dataDir, this.deps.logger);
    const store = new EpisodicMarkdownStore(join(dataDir, 'episodic'));
    this.index = new EpisodicSearchIndex(databasePath, store);
    await this.index.start();

    try {
      this.child = await this.createChild();
      this.available = true;
    } catch (error) {
      this.deps.logger.warn(
        { error },
        'Memory retrieval child failed to start — recalls will be buffered',
      );
      this.scheduleRecovery();
    }
  }

  remember(input: RecallInput): void {
    const parsed = recallInputSchema.parse(input);
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
    if (this.closed || !this.config.proactiveEnabled) return true;
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
      bufferedRecalls: this.buffered.length,
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
    void this.replaceChild();
    return null;
  }

  private sendRecall(child: ChildSessionHandle, input: RecallInput): void {
    this.sendToChild(child, renderRecall(input));
    this.recallsSent += 1;
    this.recallAnswerUntil = Date.now() + this.config.recallAnswerWindowMs;
    this.deps.logger.debug('Memory recall sent to retrieval child');
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
    const answersRecall = Date.now() < this.recallAnswerUntil;
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
    try {
      this.deps.inbox.sendMessage(
        {
          id: randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: renderSurfacedMemory(memory) }],
        } as ExtendedUIMessage,
        urgency,
      );
      this.deps.logger.debug(
        { answersRecall, urgency },
        'Surfaced memory delivered to main session',
      );
    } catch (error) {
      this.deps.logger.debug(
        { error },
        'Surfaced memory could not be delivered',
      );
    }
  }

  private async replaceChild(): Promise<void> {
    if (this.closed || this.child) return;
    try {
      this.child = await this.createChild();
      if (this.closed) {
        await this.child.close().catch(() => undefined);
        this.child = null;
        return;
      }
      this.available = true;
      this.recoveryDelayMs = RETRIEVAL_RECOVERY_DELAY_MS;
      this.flushBuffered();
    } catch (error) {
      this.deps.logger.warn(
        { error },
        'Memory retrieval child replacement failed',
      );
      this.scheduleRecovery();
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
      void this.replaceChild();
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
  return wrapMemoryResult(lines.join('\n'));
}

export function createMemoryRetrievalCoordinator(
  deps: CoordinatorDeps,
  config?: Partial<MemoryRetrievalConfig>,
): MemoryRetrievalCoordinator {
  return new MemoryRetrievalCoordinatorImpl(deps, config);
}

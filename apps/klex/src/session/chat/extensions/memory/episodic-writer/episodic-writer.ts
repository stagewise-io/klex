import { join } from 'node:path';

import { type ToolSet, tool } from 'ai';
import z from 'zod';

import { createAudioInputOptimizerExt } from '@/session/chat/extensions/audio-input-optimizer';
import { createContextCompactionExt } from '@/session/chat/extensions/context-compaction';
import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '@/session/chat/extensions/extension-api';
import { createImageInputOptimizerExt } from '@/session/chat/extensions/image-input-optimizer';
import { createNameLoaderExt } from '@/session/chat/extensions/name-loader';
import { createSoulExt } from '@/session/chat/extensions/soul';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { LINES_FORMAT_PROMPT } from '@/session/chat/utils/history-view';
import { getExtensionIdentifier } from '@/session/chat/utils/tracing';
import { SessionInboxUrgency } from '@/session/inbox';
import type { ChildSessionHandle } from '@/session/types';

import { settleBefore } from '../settle-before';
import { EpisodeStore } from './episode-files';
import { createWriterInputExt } from './writer-input';
import writerPrompt from './writer-prompt.md';

const WRITER_IDLE_WAIT_MS = 25_000;
const WRITER_RECOVERY_DELAY_MS = 1_000;
const MAX_BUFFERED_INPUT_CHARACTERS = 48_000;

interface QueuedWriterMessage {
  deliveredToSessionId: string | null;
  message: ExtendedUIMessage;
  size: number;
}

class MemorizeExt implements Extension {
  constructor(private readonly store: EpisodeStore) {}

  getTools(): ToolSet {
    return {
      memorize: tool({
        description: 'Create one memory. One call per detail.',
        inputSchema: z.object({
          data: z
            .string()
            .trim()
            .min(1)
            .refine((value) => !/[\r\n]/.test(value), {
              message: 'Memory data must be a single line.',
            })
            .describe('Single-line, terse, dense information to memorize.'),
          time: z
            .string()
            .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
            .describe(
              'When the event happened, as "HH:mm". Infer from the latest known main-session timestamp. Time may move backward when the local clock changes.',
            ),
        }),
        execute: async ({ data, time }) => {
          await this.store.store({ data, time });
          return 'Stored';
        },
      }),
    };
  }

  introspect(): Record<string, unknown> {
    return this.store.introspect();
  }
}

function createMemorizeExt(store: EpisodeStore): ExtensionFactory {
  return {
    identifier: 'io.stagewise/memorize',
    displayName: 'Memorize',
    create: () => new MemorizeExt(store),
  };
}

export interface EpisodicWriter {
  readonly sessionId: string | null;
  submit(message: ExtendedUIMessage): Promise<void>;
  waitForIdle(timeoutMs: number): Promise<boolean>;
  finishCurrentEpisode(): Promise<void>;
  close(): Promise<void>;
}

class EpisodicWriterOwner implements EpisodicWriter {
  private child: ChildSessionHandle | null = null;
  private resetPromise: Promise<void> | null = null;
  private processingPromise: Promise<void> | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private readonly queue: QueuedWriterMessage[] = [];
  private bufferedInputCharacters = 0;
  private closed = false;

  constructor(
    private readonly deps: Pick<
      ExtensionDeps,
      'config' | 'createChildSession' | 'logger'
    >,
    private readonly store: EpisodeStore,
  ) {}

  get sessionId(): string | null {
    return this.child?.sessionId ?? null;
  }

  async start(): Promise<void> {
    this.child = await this.createChild();
  }

  async submit(message: ExtendedUIMessage): Promise<void> {
    if (this.closed) throw new Error('Episodic writer is not available');
    const queued = {
      deliveredToSessionId: null,
      message,
      size: messageCharacterCount(message),
    };
    this.queue.push(queued);
    this.bufferedInputCharacters += queued.size;
    this.trimQueue();
    this.startProcessing();
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const processing = this.processingPromise;
    if (processing && !(await settleBefore(processing, deadline))) return false;
    if (this.queue.length > 0 || this.resetPromise) return false;
    const remaining = Math.max(0, deadline - Date.now());
    return this.child?.waitForIdle(remaining) ?? true;
  }

  async finishCurrentEpisode(): Promise<void> {
    if (this.closed) return;
    this.store.finishCurrentEpisode();
    this.requestReset();
    await this.resetPromise;
  }

  requestReset(): void {
    if (this.closed || this.resetPromise) return;
    this.resetPromise = this.replaceChild()
      .catch((error: unknown) => {
        this.deps.logger.warn(
          { error },
          'Episodic writer reset failed — retrying with buffered input',
        );
        this.scheduleRecovery();
      })
      .finally(() => {
        this.resetPromise = null;
        if (this.store.needsReset()) this.scheduleRecovery();
        this.startProcessing();
      });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.store.close();
    const child = this.child;
    this.child = null;
    await child?.close();
  }

  private startProcessing(): void {
    if (this.closed || this.processingPromise || this.queue.length === 0)
      return;
    this.processingPromise = this.processQueue()
      .catch((error: unknown) => {
        this.deps.logger.warn(
          { error },
          'Episodic writer input processing failed — input remains buffered',
        );
        this.scheduleRecovery();
      })
      .finally(() => {
        this.processingPromise = null;
        if (!this.closed && this.queue.length > 0) this.scheduleRecovery();
      });
  }

  private async processQueue(): Promise<void> {
    while (!this.closed && this.queue.length > 0) {
      if (this.store.needsReset()) {
        this.requestReset();
        await this.resetPromise;
        if (this.store.needsReset()) return;
      }

      const child = await this.requireChild();
      if (!child) return;
      const queued = this.queue[0];
      if (!queued) return;

      if (queued.deliveredToSessionId !== child.sessionId) {
        child.inbox.sendMessage(queued.message, SessionInboxUrgency.Default);
        queued.deliveredToSessionId = child.sessionId;
      }

      const idle = await child.waitForIdle(WRITER_IDLE_WAIT_MS);
      if (this.closed) return;
      const status = child.getSessionInfo().status;
      if (idle && status === 'active') {
        this.queue.shift();
        this.bufferedInputCharacters -= queued.size;
        continue;
      }
      if (status === 'terminated') {
        this.deps.logger.warn(
          { episodicMemoryWriterId: child.sessionId },
          'Episodic writer terminated — creating a replacement and retrying buffered input',
        );
        if (this.child === child) this.child = null;
        queued.deliveredToSessionId = null;
        await child.close().catch(() => undefined);
        continue;
      }
      this.deps.logger.warn(
        {
          episodicMemoryWriterId: child.sessionId,
          timeoutMs: WRITER_IDLE_WAIT_MS,
        },
        'Episodic writer is still busy — retaining buffered input',
      );
      return;
    }
  }

  private async requireChild(): Promise<ChildSessionHandle | null> {
    if (this.child?.getSessionInfo().status === 'active') return this.child;
    const stale = this.child;
    this.child = null;
    await stale?.close().catch(() => undefined);
    const replacement = await this.createChild();
    if (this.closed) {
      await replacement.close();
      return null;
    }
    this.child = replacement;
    return replacement;
  }

  private async replaceChild(): Promise<void> {
    const previous = this.child;
    if (previous) {
      const info = previous.getSessionInfo();
      if (info.status === 'active') {
        const idle = await previous.waitForIdle(WRITER_IDLE_WAIT_MS);
        if (!idle) {
          throw new Error('Episodic writer did not become idle for reset');
        }
      }
      await previous.close();
      if (this.child === previous) this.child = null;
    }

    const replacement = await this.createChild();
    if (this.closed) {
      await replacement.close();
      return;
    }
    this.child = replacement;
    await this.store.completeReset();
  }

  private scheduleRecovery(): void {
    if (this.closed || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.store.needsReset()) this.requestReset();
      this.startProcessing();
    }, WRITER_RECOVERY_DELAY_MS);
  }

  private trimQueue(): void {
    let droppedMessages = 0;
    let droppedCharacters = 0;
    while (
      this.bufferedInputCharacters > MAX_BUFFERED_INPUT_CHARACTERS &&
      this.queue.length > 1
    ) {
      const firstIsInFlight = this.queue[0]?.deliveredToSessionId !== null;
      const dropIndex = firstIsInFlight ? 1 : 0;
      const [dropped] = this.queue.splice(dropIndex, 1);
      if (!dropped) break;
      droppedMessages += 1;
      droppedCharacters += dropped.size;
      this.bufferedInputCharacters -= dropped.size;
    }
    if (droppedMessages > 0) {
      this.deps.logger.warn(
        {
          droppedCharacters,
          droppedMessages,
          maxBufferedInputCharacters: MAX_BUFFERED_INPUT_CHARACTERS,
        },
        'Episodic writer buffer limit reached — dropped oldest pending input',
      );
    }
  }

  private createChild(): Promise<ChildSessionHandle> {
    const memoryModels = this.deps.config.getModelSelection('memory');
    const modelPurpose = memoryModels.length > 0 ? 'memory' : ('chat' as const);
    if (modelPurpose === 'chat') {
      this.deps.logger.info(
        { modelPurpose },
        'No memory models configured — episodicMemoryWriter falling back to chat models',
      );
    }
    return this.deps.createChildSession({
      name: 'episodic-memory-writer',
      extensionIdentifier: getExtensionIdentifier() ?? 'memory',
      extensions: [
        createNameLoaderExt,
        createSoulExt,
        createContextCompactionExt,
        createWriterInputExt,
        createImageInputOptimizerExt,
        createAudioInputOptimizerExt,
        createMemorizeExt(this.store),
      ],
      basePrompt: `${writerPrompt}\n\n${LINES_FORMAT_PROMPT}`,
      modelPurpose,
    });
  }
}

function messageCharacterCount(message: ExtendedUIMessage): number {
  return message.parts.reduce((total, part) => {
    if (part.type === 'text') return total + part.text.length;
    if (part.type === 'file') return total + part.url.length;
    if (part.type.startsWith('data-')) {
      return total + dataCharacterCount((part as { data: unknown }).data);
    }
    return total;
  }, 0);
}

function dataCharacterCount(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + dataCharacterCount(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce(
      (total, item) => total + dataCharacterCount(item),
      0,
    );
  }
  return 0;
}

export async function createEpisodicWriter(
  deps: Pick<
    ExtensionDeps,
    'config' | 'createChildSession' | 'getDataDir' | 'logger'
  >,
  timezone: string,
): Promise<EpisodicWriter> {
  let owner: EpisodicWriterOwner;
  const extensionDataDirectory = deps.getDataDir(true);
  const store = new EpisodeStore({
    episodicDir: join(extensionDataDirectory, 'episodic'),
    timezone,
    onResetRequired: () => owner.requestReset(),
  });
  owner = new EpisodicWriterOwner(deps, store);
  await owner.start();
  return owner;
}

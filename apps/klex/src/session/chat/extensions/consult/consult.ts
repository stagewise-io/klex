import { randomUUID } from 'node:crypto';

import type { ToolSet } from 'ai';
import z from 'zod';

import type { ChildSessionHandle } from '@/session/types';

import { SessionInboxUrgency } from '../../inbox';
import type { ExtendedUIMessage } from '../../message-types';
import {
  createDataPart,
  dataPartTransformer,
  type Extension,
  type ExtensionDeps,
  type ExtensionFactory,
  isDataPartOf,
  type ProvisionalStepContext,
} from '../extension-api';
import { CONTEXT_SUMMARY_KEY, serializeHistoryAsXml } from '../history-xml';
import consultSystemPrompt from './consult-system-prompt.md';
import mainSystemPrompt from './main-system-prompt.md';
import {
  CONSULT_REPORT_KEY,
  CONSULTS_KEY,
  type ConsultReportData,
  type ConsultSession,
  type ConsultSessionContextData,
  contextPrompt,
  reportPrompt,
  sessionsPrompt,
  updatePrompt,
} from './serializer';

const reportSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1)
    .max(6_000)
    .describe('Update to give to the main session.'),
  final: z.boolean().describe('True if your final verdict.'),
});

const startSchema = z.object({
  task: z
    .string()
    .trim()
    .min(1)
    .max(6_000)
    .describe(
      'Self-contained problem or question, plus only the context needed to solve it. Write with short sentences, clear definitions, and no ambiguity. Contain all evidence in high-density format.',
    ),
});

const updateSchema = z.object({
  handle: z
    .string()
    .regex(/^dt\d+$/)
    .describe('Short consult handle, such as dt1 or dt2'),
  content: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe('Important new info for consult.'),
});

const abortSchema = z.object({
  handle: z
    .string()
    .regex(/^dt\d+$/)
    .describe('Short consult handle, such as dt1 or dt2'),
});

function sessionChanges(
  previous: ConsultSession[],
  current: ConsultSession[],
): string[] {
  const previousByHandle = new Map(
    previous.map((session) => [session.handle, session]),
  );
  const currentHandles = new Set(current.map((session) => session.handle));
  const changes: string[] = [];

  for (const session of current) {
    const prior = previousByHandle.get(session.handle);
    if (!prior) {
      changes.push(`${session.handle} started. status: ${session.status}`);
    } else if (prior.status !== session.status) {
      changes.push(`${session.handle} changed status: ${session.status}`);
    }
  }
  for (const session of previous) {
    if (!currentHandles.has(session.handle)) {
      changes.push(`${session.handle} deleted.`);
    }
  }
  return changes;
}

type ConsultEntry = {
  child: ChildSessionHandle;
  generationId: string;
  reportCount: number;
  startedAt: string;
  status: 'running' | 'finished';
};

export interface ConsultExtConfig {
  childExtensionFactories: ExtensionFactory[];
  maxActiveSessions: number;
  maxReportsPerSession: number;
  /** Number of most recent parent messages sent to each consult. */
  maxContextMessages?: number;
}

class ConsultReporter implements Extension {
  constructor(
    private readonly report: (
      content: string,
      final: boolean,
    ) => Promise<boolean>,
  ) {}

  getTools(): ToolSet {
    return {
      report: {
        description:
          'Send finding to main. Set final to true if thinking is finished.',
        inputSchema: reportSchema,
        outputSchema: z.object({ accepted: z.boolean() }),
        execute: async ({ content, final }) => {
          const accepted = await this.report(content, final);
          return { accepted };
        },
      },
    } satisfies ToolSet;
  }
}

function createReporterFactory(
  report: (content: string, final: boolean) => Promise<boolean>,
): ExtensionFactory {
  return {
    identifier: 'io.stagewise/consult-reporter',
    displayName: 'consult-reporter',
    create: () => new ConsultReporter(report),
  };
}

class ConsultExtension implements Extension {
  private readonly entries = new Map<string, ConsultEntry>();
  private readonly allocatedHandles = new Set<string>();
  private closed = false;
  private readonly startOperations = new Set<Promise<unknown>>();

  constructor(
    private readonly deps: ExtensionDeps,
    private readonly config: ConsultExtConfig,
  ) {}

  getTools(): ToolSet {
    return {
      startConsult: {
        inputSchema: startSchema,
        outputSchema: z.discriminatedUnion('status', [
          z.object({
            handle: z.string().regex(/^dt\d+$/),
            status: z.literal('running'),
          }),
          z.object({
            reason: z.enum([
              'capacity-reached',
              'child-start-failed',
              'extension-closed',
              'no-model',
              'task-delivery-failed',
            ]),
            status: z.literal('failed'),
          }),
        ]),
        execute: async ({ task }) => this.start(task),
      },
      updateConsult: {
        description: 'Send relevant new info',
        inputSchema: updateSchema,
        outputSchema: z.object({
          status: z.enum(['running', 'not-found']),
        }),
        execute: async ({ handle, content }) => this.update(handle, content),
      },
      abortConsult: {
        description: 'Use if too slow, off rails or no longer needed',
        inputSchema: abortSchema,
        outputSchema: z.object({
          status: z.enum(['closed', 'close-failed', 'not-found']),
        }),
        execute: async ({ handle }) => this.abort(handle),
      },
    } satisfies ToolSet;
  }

  getSystemPromptPart(): string {
    return mainSystemPrompt;
  }

  dataPartTransformers = {
    [CONSULT_REPORT_KEY]: dataPartTransformer<ConsultReportData>((data) => [
      { type: 'text', text: reportPrompt(data) },
    ]),
    [CONSULTS_KEY]: dataPartTransformer<ConsultSessionContextData>((data) => [
      { type: 'text', text: sessionsPrompt(data) },
    ]),
  };

  getProvisionalStepContext(
    history: readonly ExtendedUIMessage[],
  ): ProvisionalStepContext {
    const current = this.sessionContextData().sessions;
    const previous = this.latestSessionContext(history);
    if (!previous) {
      if (current.length === 0) return { parts: [] };
      return this.sessionContextPart({ mode: 'full', sessions: current });
    }
    const changes = sessionChanges(previous, current);
    if (changes.length === 0) return { parts: [] };
    return this.sessionContextPart({
      mode: 'change',
      sessions: current,
      changes,
    });
  }

  historyTransformer(history: ExtendedUIMessage[]): ExtendedUIMessage[] {
    const first = history[0];
    if (!first) return history;

    const original = this.deps.getHistory();
    const cutoffIndex = original.findIndex(
      (message) => message.id === first.id,
    );
    if (cutoffIndex <= 0) return history;

    const previous = this.latestSessionContext(original.slice(0, cutoffIndex));
    if (!previous) return history;

    return [
      {
        ...first,
        parts: [
          createDataPart(CONSULTS_KEY, {
            mode: 'full',
            sessions: previous,
          }) as never,
          ...first.parts,
        ],
      },
      ...history.slice(1),
    ];
  }

  private sessionContextPart(
    data: ConsultSessionContextData,
  ): ProvisionalStepContext {
    return {
      parts: [
        createDataPart(CONSULTS_KEY, data),
      ] as unknown as ExtendedUIMessage['parts'],
    };
  }

  private start(task: string) {
    const operation = this.startOperation(task);
    this.startOperations.add(operation);
    void operation
      .finally(() => this.startOperations.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  private async startOperation(task: string): Promise<
    | { handle: string; status: 'running' }
    | {
        reason:
          | 'capacity-reached'
          | 'child-start-failed'
          | 'extension-closed'
          | 'no-model'
          | 'task-delivery-failed';
        status: 'failed';
      }
  > {
    if (this.closed) return { reason: 'extension-closed', status: 'failed' };
    if (this.allocatedHandles.size >= this.config.maxActiveSessions) {
      return { reason: 'capacity-reached', status: 'failed' };
    }
    if (this.deps.config.getModelSelection('consult').length === 0) {
      return { reason: 'no-model', status: 'failed' };
    }
    const handle = this.allocateHandle();
    const generationId = randomUUID();

    const reporter = createReporterFactory((content, final) =>
      this.receiveReport(handle, generationId, content, final),
    );
    let child: ConsultEntry['child'];
    try {
      child = await this.deps.createChildSession({
        // Stable role name: it becomes the `session consult` span name and a
        // metric label. The handle ↔ session id mapping is logged below.
        name: 'consult',
        extensionIdentifier: 'consult',
        extensions: [...this.config.childExtensionFactories, reporter],
        modelPurpose: 'consult',
        basePrompt: consultSystemPrompt,
        hooks: {
          onTerminated: ({ sessionId, reason }) =>
            this.childTerminated(handle, generationId, sessionId, reason),
        },
      });
    } catch (error) {
      this.releaseHandle(handle);
      this.deps.logger.error({ error, handle }, 'Consult child start failed');
      return { reason: 'child-start-failed', status: 'failed' };
    }
    if (this.closed) {
      const closed = await this.closeChildBestEffort(handle, child);
      if (!closed) {
        this.entries.set(handle, {
          child,
          generationId,
          reportCount: 0,
          startedAt: new Date().toISOString(),
          status: 'finished',
        });
      }
      return { reason: 'extension-closed', status: 'failed' };
    }

    const entry: ConsultEntry = {
      child,
      generationId,
      reportCount: 0,
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    this.entries.set(handle, entry);
    this.deps.logger.info(
      { handle, childSessionId: child.sessionId },
      'Consult child started',
    );

    try {
      const history = this.deps.getHistory();
      const serializedContext = serializeHistoryAsXml(history, {
        includeUnknownData: false,
        maxCharacters: 12_000,
        recentMessageLimit: this.config.maxContextMessages ?? 5,
        summaryKey: CONTEXT_SUMMARY_KEY,
      });
      const delivered = child.inbox.sendMessage(
        {
          id: randomUUID(),
          role: 'user',
          parts: [
            { type: 'text', text: contextPrompt(serializedContext) },
            { type: 'text', text: task },
          ],
        },
        SessionInboxUrgency.Default,
      );
      if (delivered === false) throw new Error('Child task was not delivered');
      return { handle, status: 'running' };
    } catch (error) {
      entry.status = 'finished';
      this.deps.logger.error(
        { error, handle, childSessionId: child.sessionId },
        'Consult task delivery failed',
      );
      await this.finishClosingEntry(handle, entry);
      return { reason: 'task-delivery-failed', status: 'failed' };
    }
  }

  private async update(handle: string, content: string) {
    const entry = this.entries.get(handle);
    if (!entry || entry.status !== 'running') {
      return { status: 'not-found' as const };
    }
    try {
      entry.child.inbox.sendMessage(
        {
          id: randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: updatePrompt(content) }],
        },
        SessionInboxUrgency.Deferrable,
      );
      return { status: 'running' as const };
    } catch (error) {
      entry.status = 'finished';
      this.deps.logger.error(
        { error, handle, childSessionId: entry.child.sessionId },
        'Consult context delivery failed',
      );
      await this.finishClosingEntry(handle, entry);
      return { status: 'not-found' as const };
    }
  }

  private async abort(handle: string) {
    const entry = this.entries.get(handle);
    if (!entry) return { status: 'not-found' as const };
    entry.status = 'finished';
    const closed = await this.finishClosingEntry(handle, entry);
    if (closed) {
      this.deps.logger.info(
        { handle, childSessionId: entry.child.sessionId },
        'Consult child aborted',
      );
      return { status: 'closed' as const };
    }
    return { status: 'close-failed' as const };
  }

  private async receiveReport(
    handle: string,
    generationId: string,
    content: string,
    final: boolean,
  ): Promise<boolean> {
    const entry = this.entries.get(handle);
    if (
      !entry ||
      entry.generationId !== generationId ||
      entry.status !== 'running'
    ) {
      return false;
    }
    entry.reportCount += 1;
    const limitReached = entry.reportCount >= this.config.maxReportsPerSession;
    const terminal = final || limitReached;
    this.deps.logger.info(
      { handle, reportCount: entry.reportCount, final, limitReached },
      'Consult report received',
    );
    if (!terminal) {
      return this.emitReport(handle, content);
    }

    entry.status = 'finished';
    try {
      const delivered = this.emitReport(handle, content, terminal);
      return delivered;
    } finally {
      await this.finishClosingEntry(handle, entry);
    }
  }

  private childTerminated(
    handle: string,
    generationId: string,
    childSessionId: string,
    reason: string,
  ): void {
    const entry = this.entries.get(handle);
    if (
      !entry ||
      entry.generationId !== generationId ||
      entry.child.sessionId !== childSessionId
    ) {
      return;
    }
    this.deleteEntry(handle);
    if (this.closed || entry.status !== 'running') return;
    this.deps.logger.error(
      { handle, childSessionId, reason },
      'Consult child terminated before a final report',
    );
    this.tryEmitReport(
      handle,
      'Consult stopped before producing a final verdict.',
      false,
      childSessionId,
    );
  }

  private emitReport(handle: string, content: string, final = false): boolean {
    return (
      this.deps.inbox.sendMessage(
        {
          id: randomUUID(),
          role: 'user',
          parts: [
            createDataPart(CONSULT_REPORT_KEY, {
              handle,
              content,
              ...(final ? { final: true } : {}),
            }),
          ],
        } as unknown as ExtendedUIMessage,
        SessionInboxUrgency.Default,
      ) !== false
    );
  }

  private allocateHandle(): string {
    for (let number = 1; ; number++) {
      const handle = `dt${number}`;
      if (!this.allocatedHandles.has(handle)) {
        this.allocatedHandles.add(handle);
        return handle;
      }
    }
  }

  private releaseHandle(handle: string): void {
    this.allocatedHandles.delete(handle);
  }

  private deleteEntry(handle: string): boolean {
    const deleted = this.entries.delete(handle);
    if (deleted) this.releaseHandle(handle);
    return deleted;
  }

  private sessionContextData(): { sessions: ConsultSession[] } {
    return {
      sessions: [...this.entries].map(([handle, entry]) => ({
        childSessionId: entry.child.sessionId,
        handle,
        reportCount: entry.reportCount,
        startedAt: entry.startedAt,
        status: entry.status,
      })),
    };
  }

  private latestSessionContext(
    history: readonly ExtendedUIMessage[],
  ): ConsultSession[] | null {
    for (
      let messageIndex = history.length - 1;
      messageIndex >= 0;
      messageIndex--
    ) {
      const message = history[messageIndex]!;
      for (
        let partIndex = message.parts.length - 1;
        partIndex >= 0;
        partIndex--
      ) {
        const part = message.parts[partIndex]!;
        if (isDataPartOf(CONSULTS_KEY, part as never)) {
          const data = (
            part as unknown as {
              data: ConsultSessionContextData;
            }
          ).data;
          return data.sessions;
        }
      }
    }
    return null;
  }

  introspect = () => ({
    lifecycle: this.closed ? 'closed' : 'active',
    sessions: this.sessionContextData().sessions,
  });

  private tryEmitReport(
    handle: string,
    content: string,
    final = false,
    childSessionId?: string,
  ): void {
    try {
      this.emitReport(handle, content, final);
    } catch (error) {
      this.deps.logger.error(
        { error, handle, childSessionId },
        'Consult report delivery failed',
      );
    }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.startOperations]);
    const entries = [...this.entries];
    await Promise.all(
      entries.map(async ([handle, entry]) => {
        entry.status = 'finished';
        await this.finishClosingEntry(handle, entry);
      }),
    );
  }

  private async finishClosingEntry(
    handle: string,
    entry: ConsultEntry,
  ): Promise<boolean> {
    const closed = await this.closeChildBestEffort(handle, entry.child);
    if (closed) this.deleteEntry(handle);
    return closed;
  }

  private async closeChildBestEffort(
    handle: string,
    child: ChildSessionHandle,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await child.close();
        return true;
      } catch (error) {
        this.deps.logger.error(
          { attempt, error, handle, childSessionId: child.sessionId },
          'Consult child close failed',
        );
      }
    }
    return false;
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

export function createConsultExt(config: ConsultExtConfig): ExtensionFactory {
  validatePositiveInteger(config.maxActiveSessions, 'maxActiveSessions');
  validatePositiveInteger(config.maxReportsPerSession, 'maxReportsPerSession');
  if (config.maxContextMessages !== undefined) {
    validatePositiveInteger(config.maxContextMessages, 'maxContextMessages');
  }
  return {
    identifier: 'io.stagewise/consult',
    displayName: 'consult',
    create: (deps) => new ConsultExtension(deps, config),
  };
}

import type { ToolSet } from 'ai';
import z from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import {
  type ContextDataUIPart,
  type SessionInboxEvent,
  SessionInboxUrgency,
} from '@/session/inbox';

import type {
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extension-api';

type ReminderUnit = 'seconds' | 'minutes' | 'hours' | 'days';

interface ReminderEntry {
  handle: number;
  topic: string;
  setAt: string;
  firesAt: number;
  timeoutId: NodeJS.Timeout;
}

const UNIT_TO_MS: Record<ReminderUnit, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

const MAX_TOPIC_LENGTH = 200;
const MAX_DURATION_DAYS = 7;
const MAX_DELAY_MS = MAX_DURATION_DAYS * 86_400_000;
const MAX_CONCURRENT_REMINDERS = 10;

class RemindersExtension implements Extension {
  private readonly reminders = new Map<number, ReminderEntry>();
  private nextHandle = 1;
  private closed = false;

  constructor(
    private readonly deps: {
      router: ExtensionDeps['router'];
      sessionId: string;
      logger: ModuleLogger;
    },
  ) {}

  onStart(): Promise<void> {
    this.deps.logger.info('Reminders extension started');
    return Promise.resolve();
  }

  async onClose(): Promise<void> {
    // Do NOT clear pending reminders. Reminders are router-routed: when
    // they fire, the router dispatches the event to whatever session is
    // active (including a replacement if this session self-terminated).
    // Clearing them here would defeat the survival guarantee.
    //
    // The `closed` flag prevents new reminder creation (setReminder)
    // and clearing (clearReminder). Existing reminders will still fire
    // and send events through the router.
    const pending = this.reminders.size;
    this.closed = true;
    this.deps.logger.info(
      { pendingReminders: pending },
      'Reminders extension closed — pending reminders will still fire through the router',
    );
  }

  getTools(): ToolSet {
    return {
      setReminder: {
        inputSchema: z.object({
          duration: z
            .number()
            .int()
            .positive()
            .describe(
              'How long until the reminder fires. MUST be a positive number. ' +
                `Maximum total duration is ${MAX_DURATION_DAYS} days across all units.`,
            ),
          unit: z
            .enum(['seconds', 'minutes', 'hours', 'days'])
            .describe('The time unit for the duration.'),
          topic: z
            .string()
            .min(1)
            .max(MAX_TOPIC_LENGTH)
            .describe(
              'A self-contained description of what should happen when the reminder fires and why it was set. ' +
                'This is the ONLY information you receive when the reminder fires, so it must include all ' +
                'context needed to act on it. Example: ' +
                '"Check if the deploy at https://api.example.com succeeded — user asked for a health check in 10 minutes".',
            ),
        }),
        outputSchema: z.object({
          handle: z
            .number()
            .int()
            .describe(
              'A numeric handle that allows you to cancel this reminder with clearReminder.',
            ),
        }),
        execute: async ({ duration, unit, topic }) => {
          if (this.closed) {
            throw new Error(
              'Reminders extension is closed — cannot set new reminders',
            );
          }
          if (this.reminders.size >= MAX_CONCURRENT_REMINDERS) {
            throw new Error(
              `Maximum of ${MAX_CONCURRENT_REMINDERS} concurrent reminders reached — ` +
                'clear one before setting a new one',
            );
          }
          return this.setReminder(duration, unit as ReminderUnit, topic);
        },
      },
      clearReminder: {
        inputSchema: z.object({
          handle: z
            .number()
            .int()
            .describe('The handle returned by setReminder.'),
        }),
        outputSchema: z.object({
          cancelled: z
            .boolean()
            .describe(
              'true if the reminder was found and cancelled, false if not found or already fired.',
            ),
        }),
        execute: async ({ handle }) => {
          if (this.closed) {
            throw new Error(
              'Reminders extension is closed — cannot clear reminders',
            );
          }
          return { cancelled: this.clearReminder(handle) };
        },
      },
    } satisfies ToolSet;
  }

  getSystemPromptPart(): string {
    return [
      '# Reminders',
      '',
      'Use `setReminder(duration, unit, topic)` to set a one-shot reminder. When the reminder fires, a context event with the topic arrives in the session.',
      '',
      '**The `topic` is the only information you receive when the reminder fires.** It must be self-contained — include what should happen, why the reminder was set, and any context needed to act on it.',
      '',
      'Example: `"Check if the deploy at https://api.example.com succeeded — user asked for a health check in 10 minutes"`',
      '',
      `Reminders are one-shot. Set a new one for recurring events. Maximum duration is ${MAX_DURATION_DAYS} days. ` +
        `Maximum ${MAX_CONCURRENT_REMINDERS} concurrent reminders per session. ` +
        'Use `clearReminder(handle)` to cancel a pending reminder.',
    ].join('\n');
  }

  introspect(): Record<string, unknown> {
    const entries = [...this.reminders.values()].sort(
      (a, b) => a.firesAt - b.firesAt,
    );
    const first = entries[0];
    return {
      activeReminders: entries.length,
      closed: this.closed,
      nextFireAt: first ? new Date(first.firesAt).toISOString() : null,
      reminders: entries.map((e) => ({
        handle: e.handle,
        topic: e.topic,
        setAt: e.setAt,
        firesAt: new Date(e.firesAt).toISOString(),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal reminder management
  // ---------------------------------------------------------------------------

  private setReminder(
    duration: number,
    unit: ReminderUnit,
    topic: string,
  ): { handle: number } {
    const delayMs = duration * UNIT_TO_MS[unit];

    if (delayMs > MAX_DELAY_MS) {
      throw new Error(`Duration exceeds maximum of ${MAX_DURATION_DAYS} days`);
    }

    const handle = this.nextHandle++;
    const now = Date.now();
    const setAt = new Date(now).toISOString();
    const firesAt = now + delayMs;

    const timeoutId = setTimeout(() => {
      this.fireReminder(handle, topic, setAt);
    }, delayMs);

    this.reminders.set(handle, {
      handle,
      topic,
      setAt,
      firesAt,
      timeoutId,
    });

    this.deps.logger.debug({ handle, duration, unit, delayMs }, 'Reminder set');

    return { handle };
  }

  private clearReminder(handle: number): boolean {
    const entry = this.reminders.get(handle);
    if (!entry) return false;
    clearTimeout(entry.timeoutId);
    this.reminders.delete(handle);
    this.deps.logger.debug({ handle }, 'Reminder cleared');
    return true;
  }

  private fireReminder(handle: number, topic: string, setAt: string): void {
    // Remove from the map first — the reminder has fired.
    this.reminders.delete(handle);

    const firedAt = new Date().toISOString();

    const metadata: ContextDataUIPart['metadata'] = {
      type: 'reminder.fired',
      handle,
      topic,
      originSessionId: this.deps.sessionId,
      setAt,
      firedAt,
    };

    const event: SessionInboxEvent = {
      sourceEnv: 'reminders',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'reminders',
        metadata,
        content: [{ type: 'text', text: `Reminder fired: ${topic}` }],
      },
    };

    // Fire-and-forget — the router dispatches to the active session.
    // If the originating session has terminated, the router creates a
    // replacement and delivers there. This is the survival guarantee.
    void this.deps.router.sendInput(event).catch((error: unknown) => {
      this.deps.logger.error(
        { handle, topic, error },
        'Failed to send reminder event to router',
      );
    });

    this.deps.logger.info(
      {
        handle,
        topic,
        originSessionId: this.deps.sessionId,
        closed: this.closed,
      },
      'Reminder fired — event sent to router',
    );
  }
}

export const createRemindersExt: ExtensionFactory = {
  identifier: 'io.stagewise/reminders',
  displayName: 'Reminders',
  create: (deps) =>
    new RemindersExtension({
      router: deps.router,
      sessionId: deps.sessionId,
      logger: deps.logger,
    }),
};

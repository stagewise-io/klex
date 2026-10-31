import type { ToolSet } from 'ai';

import {
  type LearningSubmission,
  learningSubmissionSchema,
  validateOperations,
} from '../operations';

const TOOL_NAME = 'submitLearnings';
export interface LearningSubmissionTools {
  tools: ToolSet;
  instructions: string;
}

export interface LearningSubmissionToolsOptions {
  evidence: ReadonlySet<string>;
  getExistingNames: () => readonly string[];
  persist: (submission: LearningSubmission) => Promise<number>;
  allowDefer: boolean;
  allowCreate: boolean;
  signal: AbortSignal;
}

/** Validated batches persist during tool execution, once per investigation. */
class LearningSubmissionToolsModule implements LearningSubmissionTools {
  readonly tools: ToolSet;
  private submitted = false;
  readonly instructions: string;

  constructor(private readonly options: LearningSubmissionToolsOptions) {
    this.instructions = [
      '## Learning submission protocol',
      'Use the read-only episode tools to investigate, then call submitLearnings once with the complete operation batch. Do not submit learnings as text or fenced JSON. The tool schema defines the operation structure and limits.',
      'Submit operations: [] when nothing should change. A rejected batch is not a submission; correct the reported problem and call submitLearnings again. Never drop an invalid operation silently.',
      options.allowDefer
        ? 'If evidence remains insufficient and later episodes may resolve it, submit operations: [] with deferred: true. A deferral must not contain operations.'
        : 'Consolidation cannot defer. Preserve existing skills when evidence is insufficient and submit operations: [] if nothing can safely change.',
      options.allowCreate
        ? 'Create or update skills supported by evidence. Delete only skills verified as superseded; do not discard unrelated skills.'
        : 'Only update or delete existing skills. Consolidation cannot create skills or invent new lessons; merge into an existing survivor.',
      'Only cite episode IDs actually exposed in this investigation. Successful submissions write immediately. Investigate briefly, submit one complete batch, then stop. Later model failures do not undo persisted changes.',
    ].join('\n\n');
    this.tools = {
      [TOOL_NAME]: {
        description:
          'Validate and persist one complete learning batch. Empty operations explicitly means no learning. Rejections return feedback without writing anything. Stop after a successful submission.',
        inputSchema: learningSubmissionSchema,
        execute: async (input) => {
          if (options.signal.aborted) return { status: 'cancelled' };
          if (this.submitted) return { status: 'already-submitted' };
          // Validate here as well so non-SDK callers cannot bypass the schema.
          const parsed = learningSubmissionSchema.safeParse(input);
          if (!parsed.success)
            return {
              status: 'rejected',
              reason: 'Invalid submission schema',
              issues: parsed.error.issues,
            };
          const problem = this.problem(parsed.data);
          if (problem) return { status: 'rejected', reason: problem };
          // Claim before awaiting persistence, including if a partial write fails.
          this.submitted = true;
          try {
            const applied = await options.persist(parsed.data);
            return {
              status: 'applied',
              applied,
              deferred: parsed.data.deferred ?? false,
            };
          } catch {
            return {
              status: 'failed',
              reason:
                'Learning persistence failed; this batch will not be replayed.',
            };
          }
        },
      },
    };
  }

  private problem(submission: LearningSubmission): string | null {
    if (this.options.signal.aborted) return 'Submission cancelled';
    const existingNames = this.options.getExistingNames();
    if (
      submission.deferred &&
      (!this.options.allowDefer || submission.operations.length > 0)
    )
      return 'Deferral is allowed only for extraction with an empty operation batch';
    for (const operation of submission.operations) {
      if (operation.op === 'create' && !this.options.allowCreate)
        return 'Consolidation cannot create skills; update an existing survivor instead';
      if (operation.op === 'delete') continue;
      if (
        operation.evidenceEpisodes?.some((id) => !this.options.evidence.has(id))
      )
        return `Unread evidence cited for skill "${operation.name}"`;
      if (
        operation.op === 'update' &&
        operation.mergedFrom?.some((name) => !existingNames.includes(name))
      )
        return `Unknown merge source for skill "${operation.name}"`;
    }
    const { rejected } = validateOperations(
      submission.operations,
      existingNames,
    );
    return rejected[0]?.reason ?? null;
  }
}

export function createLearningSubmissionTools(
  options: LearningSubmissionToolsOptions,
): LearningSubmissionTools {
  return new LearningSubmissionToolsModule(options);
}

import type { ToolSet } from 'ai';
import { z } from 'zod';

import type {
  GeneratedToolResult,
  GenerateTextArgs,
} from '@/session/chat/extensions/extension-api';

import {
  type LearningSubmission,
  learningSubmissionSchema,
  validateOperations,
} from '../operations';

const TOOL_NAME = 'submitLearnings';
const acceptedSchema = z.object({
  status: z.literal('accepted'),
  submission: learningSubmissionSchema,
});

export interface LearningSubmissionTools {
  tools: ToolSet;
  completionTool: NonNullable<GenerateTextArgs['completionTool']>;
  instructions: string;
  read(
    results: readonly GeneratedToolResult[],
  ):
    | { ok: true; submission: LearningSubmission }
    | { ok: false; error: string };
}

export interface LearningSubmissionToolsOptions {
  evidence: ReadonlySet<string>;
  existingNames: readonly string[];
  allowDefer: boolean;
  signal: AbortSignal;
}

/** Accepted batches live only in SDK tool results, never in the skill store. */
class LearningSubmissionToolsModule implements LearningSubmissionTools {
  readonly tools: ToolSet;
  readonly completionTool = {
    name: TOOL_NAME,
    isComplete: (output: unknown) => acceptedSchema.safeParse(output).success,
  };
  readonly instructions: string;

  constructor(private readonly options: LearningSubmissionToolsOptions) {
    this.instructions = [
      '## Learning submission protocol',
      'Use the read-only episode tools to investigate, then call submitLearnings once with the complete operation batch. Do not submit learnings as text or fenced JSON. The tool schema defines the operation structure and limits.',
      'Submit operations: [] when nothing should change. A rejected batch is not a submission; correct the reported problem and call submitLearnings again within the remaining steps. Never drop an invalid operation silently.',
      options.allowDefer
        ? 'If evidence remains insufficient and later episodes may resolve it, submit operations: [] with deferred: true. A deferral must not contain operations.'
        : 'Consolidation cannot defer. Preserve existing skills when evidence is insufficient and submit operations: [] if nothing can safely change.',
      'Only cite episode IDs actually exposed in this investigation. A submission stages a batch without writing skills. The worker commits it only after generation succeeds. Investigation is bounded; the final step permits only submitLearnings. An accepted submission ends generation.',
    ].join('\n\n');
    this.tools = {
      [TOOL_NAME]: {
        description:
          'Validate and stage one complete learning batch. Supports create, update, and delete operations. Empty operations explicitly means no learning. Rejections return feedback without staging or writing anything.',
        inputSchema: learningSubmissionSchema,
        execute: async (input) => {
          if (options.signal.aborted) return { status: 'cancelled' };
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
          return { status: 'accepted', submission: parsed.data };
        },
      },
    };
  }

  read(results: readonly GeneratedToolResult[]) {
    const submissions: LearningSubmission[] = [];
    for (const result of results) {
      if (result.toolName !== TOOL_NAME) continue;
      const parsed = acceptedSchema.safeParse(result.output);
      if (!parsed.success) continue;
      const problem = this.problem(parsed.data.submission);
      if (problem) return { ok: false as const, error: problem };
      submissions.push(parsed.data.submission);
    }
    if (submissions.length !== 1)
      return {
        ok: false as const,
        error:
          submissions.length === 0
            ? 'No accepted submitLearnings tool result'
            : 'Multiple accepted submitLearnings batches',
      };
    return { ok: true as const, submission: submissions[0]! };
  }

  private problem(submission: LearningSubmission): string | null {
    if (this.options.signal.aborted) return 'Submission cancelled';
    if (
      submission.deferred &&
      (!this.options.allowDefer || submission.operations.length > 0)
    )
      return 'Deferral is allowed only for extraction with an empty operation batch';
    for (const operation of submission.operations) {
      if (operation.op === 'delete') continue;
      if (
        operation.evidenceEpisodes?.some((id) => !this.options.evidence.has(id))
      )
        return `Unread evidence cited for skill "${operation.name}"`;
      if (
        operation.op === 'update' &&
        operation.mergedFrom?.some(
          (name) => !this.options.existingNames.includes(name),
        )
      )
        return `Unknown merge source for skill "${operation.name}"`;
    }
    const { rejected } = validateOperations(
      submission.operations,
      this.options.existingNames,
    );
    return rejected[0]?.reason ?? null;
  }
}

export function createLearningSubmissionTools(
  options: LearningSubmissionToolsOptions,
): LearningSubmissionTools {
  return new LearningSubmissionToolsModule(options);
}

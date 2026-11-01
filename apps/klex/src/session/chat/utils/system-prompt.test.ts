import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const systemPrompt = readFileSync(
  new URL('./system-prompt.md', import.meta.url),
  'utf8',
);
const todosPrompt = readFileSync(
  new URL('../extensions/todos/system-prompt.md', import.meta.url),
  'utf8',
);

describe('concurrent request prompt contracts', () => {
  it('requires immediate acknowledgment and busy status on the sender channel', () => {
    expect(systemPrompt).toMatch(
      /text turns: before work or investigation, always acknowledge request immediately/i,
    );
    expect(systemPrompt).toMatch(
      /sender's MCP \+ conversation \(react or brief reply\)/i,
    );
    expect(systemPrompt).toMatch(
      /even when stacked: say received request, busy with another task, will follow up ASAP/i,
    );
  });

  it('queues non-preempting requests immediately with a reminder before finishing current work', () => {
    expect(todosPrompt).toMatch(
      /unless preempting, immediately queue new request via createTodo \+ reminder \(changeTodoReminder\); finish current work first/i,
    );
  });

  it('allows priority reordering and immediate preemption for user urgency', () => {
    expect(todosPrompt).toMatch(/freely reorder todos by priority/i);
    expect(todosPrompt).toMatch(
      /user says urgent \/ high-priority \/ "stop everything else": switch immediately/i,
    );
  });

  it('preserves interrupted and other active work with self-contained todos and reminders', () => {
    expect(todosPrompt).toMatch(
      /keep interrupted and other active work in self-contained todos with reminders/i,
    );
    expect(todosPrompt).toMatch(
      /descriptions must stand alone: action, requester, conversation IDs, links, needed context/i,
    );
    expect(todosPrompt).toMatch(/no todo-to-todo references/i);
  });
});

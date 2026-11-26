/** An MCP tool that a running tool call is waiting on. */
export interface ActiveMcpCall {
  namespace: string;
  name: string;
  /** ISO timestamp of when the call started. */
  startedAt: string;
}

/** A tool call that is running right now. */
export interface ActiveToolCall {
  toolCallId: string;
  /** The tool the model called, e.g. `runInSandbox`. */
  name: string;
  /** ISO timestamp of when execution started. */
  startedAt: string;
  /** MCP tools this call is running right now, oldest first. */
  mcpCalls: ActiveMcpCall[];
}

interface Entry {
  call: Omit<ActiveToolCall, 'mcpCalls'>;
  mcpCalls: Map<number, ActiveMcpCall>;
}

/**
 * The session's tool calls in flight, for live observers such as the admin
 * UI. Holds only names and start times, never inputs or results.
 */
export class ActiveToolCalls {
  private readonly entries = new Map<number, Entry>();
  private nextKey = 0;

  /** Records a started tool call until its handle ends it. */
  start(toolCallId: string, name: string): ActiveToolCallHandle {
    const key = this.nextKey++;
    const entry: Entry = {
      call: { toolCallId, name, startedAt: new Date().toISOString() },
      mcpCalls: new Map(),
    };
    this.entries.set(key, entry);
    return {
      startMcp: (reference) => {
        const mcpKey = this.nextKey++;
        entry.mcpCalls.set(mcpKey, {
          namespace: reference.namespace,
          name: reference.name,
          startedAt: new Date().toISOString(),
        });
        return () => {
          entry.mcpCalls.delete(mcpKey);
        };
      },
      end: () => {
        this.entries.delete(key);
      },
    };
  }

  /** The calls in flight, oldest first. */
  snapshot(): ActiveToolCall[] {
    return [...this.entries.values()].map(({ call, mcpCalls }) => ({
      ...call,
      mcpCalls: [...mcpCalls.values()],
    }));
  }
}

export interface ActiveToolCallHandle {
  /** Records an MCP call made on behalf of this tool call. */
  startMcp(reference: { namespace: string; name: string }): () => void;
  end(): void;
}

import type { McpInvocation } from './tool-provider';

/** Bound host-observed evidence independently of tool input/output limits. */
class InvocationEvidence {
  private readonly entries = new Map<string, McpInvocation>();
  private bytes = 2;
  private omitted = 0;
  add(invocation: McpInvocation): void {
    if (invocation.id === 'omitted-invocation-evidence') {
      this.omitted +=
        typeof invocation.input.omittedInvocations === 'number'
          ? invocation.input.omittedInvocations
          : 1;
      return;
    }
    if (this.entries.has(invocation.id)) return;
    const serialized = JSON.stringify(invocation);
    const bytes = Buffer.byteLength(serialized) + 1;
    if (this.entries.size >= 50 || this.bytes + bytes > 256 * 1024 - 512) {
      this.omitted++;
      return;
    }
    this.entries.set(invocation.id, JSON.parse(serialized));
    this.bytes += bytes;
  }
  values(): McpInvocation[] {
    return [
      ...this.entries.values(),
      ...(this.omitted
        ? [
            {
              id: 'omitted-invocation-evidence',
              executionId: '',
              namespace: '',
              name: '',
              input: {
                omittedInvocations: this.omitted,
                reason: 'MCP evidence count or byte limit exceeded',
              },
            },
          ]
        : []),
    ];
  }
}

export function createInvocationEvidence(): InvocationEvidence {
  return new InvocationEvidence();
}

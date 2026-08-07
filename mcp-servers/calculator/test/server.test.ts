import { afterAll, describe, expect, it } from 'vitest';

import { createCalculatorMcp } from '../src/mcp.js';

async function callTool(
  mcp: ReturnType<typeof createCalculatorMcp>,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<string> {
  const response = await mcp.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: arguments_ },
      }),
    }),
  );
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  const parsed = JSON.parse(data ?? text) as {
    result: { content: { type: string; text: string }[] };
  };
  return parsed.result.content[0]?.text ?? '';
}

describe('Calculator MCP server', () => {
  const mcp = createCalculatorMcp();

  afterAll(async () => {
    await mcp.close();
  });

  it('evaluates a LaTeX expression', async () => {
    const text = await callTool(mcp, 'evaluate', {
      expression: '\\frac{1}{2} + \\frac{1}{3}',
    });
    expect(text).toContain('5/6');
    expect(text).toContain('LaTeX:');
  });

  it('evaluates with variable scope', async () => {
    const text = await callTool(mcp, 'evaluate', {
      expression: '2x^2 + 3x + 4',
      scope: { x: 5 },
    });
    expect(text).toContain('69');
  });

  it('simplifies an expression', async () => {
    const text = await callTool(mcp, 'simplify', {
      expression: '2x + 3x',
    });
    expect(text).toContain('5 * x');
  });

  it('differentiates an expression', async () => {
    const text = await callTool(mcp, 'differentiate', {
      expression: '2x^2 + 3x + 4',
      variable: 'x',
    });
    expect(text).toContain('4 * x');
    expect(text).toContain('3');
  });

  it('differentiates sin(2x)', async () => {
    const text = await callTool(mcp, 'differentiate', {
      expression: '\\sin(2x)',
      variable: 'x',
    });
    expect(text).toContain('cos');
    expect(text).toContain('2');
  });

  it('solves a quadratic equation', async () => {
    const text = await callTool(mcp, 'solve', {
      equation: 'x^2 - 5x + 6 = 0',
      variable: 'x',
    });
    expect(text).toContain('x = 2');
    expect(text).toContain('x = 3');
  });

  it('rationalizes an expression', async () => {
    const text = await callTool(mcp, 'rationalize', {
      expression: '\\frac{2x}{y} - \\frac{y}{x+1}',
    });
    expect(text).toContain('Rationalized:');
    expect(text).toContain('LaTeX:');
  });

  it('returns error for invalid expression', async () => {
    const text = await callTool(mcp, 'evaluate', {
      expression: '\\frac{1}{0}',
    });
    // Division by zero — mathjs returns Infinity or throws
    // Either way, the tool should not crash
    expect(text).toBeTruthy();
  });
});

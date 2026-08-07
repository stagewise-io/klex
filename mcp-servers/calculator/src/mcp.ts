import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import {
  differentiateExpression,
  evaluateExpression,
  rationalizeExpression,
  simplifyExpression,
} from './engine.js';
import { solveEquation } from './solver.js';

export interface CalculatorMcp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

class CalculatorMcpModule implements CalculatorMcp {
  readonly #handler: ReturnType<typeof createMcpHandler>;

  constructor() {
    this.#handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: 'calculator', version: '1.0.0' },
          { capabilities: {} },
        );

        server.registerTool(
          'evaluate',
          {
            description:
              'Evaluate a mathematical expression in LaTeX format. Supports arithmetic, fractions, functions (sin, cos, log, sqrt, etc.), and variable substitution via scope.',
            inputSchema: z.object({
              expression: z
                .string()
                .trim()
                .min(1)
                .describe(
                  'Expression in LaTeX format, e.g. \\frac{1}{2} + \\frac{1}{3} or 2x^2 + 3x + 4',
                ),
              scope: z
                .record(z.string(), z.union([z.number(), z.string()]))
                .optional()
                .describe(
                  'Variable bindings as JSON object. Numbers or LaTeX strings accepted, e.g. {x: 5} or {x: "\\frac{1}{2}"}',
                ),
            }),
          },
          async (input) => {
            try {
              const result = evaluateExpression(
                input.expression,
                input.scope as Record<string, number | string> | undefined,
              );
              return {
                content: [
                  {
                    type: 'text',
                    text: `Result: ${result.result}\nLaTeX: ${result.latex}`,
                  },
                ],
              };
            } catch (error) {
              return errorContent(error);
            }
          },
        );

        server.registerTool(
          'simplify',
          {
            description:
              'Simplify an algebraic expression in LaTeX format. Combines like terms, reduces fractions, and applies algebraic rules.',
            inputSchema: z.object({
              expression: z
                .string()
                .trim()
                .min(1)
                .describe(
                  'Algebraic expression in LaTeX, e.g. 2x + 3x or \\frac{x^2 - 1}{x - 1}',
                ),
            }),
          },
          async (input) => {
            try {
              const result = simplifyExpression(input.expression);
              return {
                content: [
                  {
                    type: 'text',
                    text: `Simplified: ${result.result}\nLaTeX: ${result.latex}`,
                  },
                ],
              };
            } catch (error) {
              return errorContent(error);
            }
          },
        );

        server.registerTool(
          'differentiate',
          {
            description:
              'Compute the symbolic derivative of an expression with respect to a variable. Input in LaTeX format.',
            inputSchema: z.object({
              expression: z
                .string()
                .trim()
                .min(1)
                .describe(
                  'Expression in LaTeX, e.g. 2x^2 + 3x + 4 or \\sin(2x)',
                ),
              variable: z
                .string()
                .trim()
                .min(1)
                .describe('Variable to differentiate with respect to, e.g. x'),
            }),
          },
          async (input) => {
            try {
              const result = differentiateExpression(
                input.expression,
                input.variable,
              );
              return {
                content: [
                  {
                    type: 'text',
                    text: `Derivative: ${result.result}\nLaTeX: ${result.latex}`,
                  },
                ],
              };
            } catch (error) {
              return errorContent(error);
            }
          },
        );

        server.registerTool(
          'solve',
          {
            description:
              'Solve an equation for a variable. Handles linear, quadratic, and higher-degree polynomial equations. Non-polynomial equations are returned in simplified form. Input in LaTeX format.',
            inputSchema: z.object({
              equation: z
                .string()
                .trim()
                .min(1)
                .describe(
                  'Equation in LaTeX containing =, e.g. x^2 - 5x + 6 = 0 or 2x + 3 = 7',
                ),
              variable: z
                .string()
                .trim()
                .min(1)
                .describe('Variable to solve for, e.g. x'),
            }),
          },
          async (input) => {
            try {
              const result = solveEquation(input.equation, input.variable);
              if (result.solutions.length === 0) {
                const parts: string[] = [result.message ?? 'No solutions'];
                if (result.latex.length > 0) {
                  parts.push('', 'LaTeX:', ...result.latex);
                }
                return {
                  content: [
                    {
                      type: 'text',
                      text: parts.join('\n'),
                    },
                  ],
                };
              }
              const lines = result.solutions.map((s, i) => `  ${i + 1}. ${s}`);
              const latexLines = result.latex.map((s, i) => `  ${i + 1}. ${s}`);
              const parts = [
                `Solutions (${result.type}):`,
                ...lines,
                '',
                'LaTeX:',
                ...latexLines,
              ];
              if (result.message) parts.push('', result.message);
              return { content: [{ type: 'text', text: parts.join('\n') }] };
            } catch (error) {
              return errorContent(error);
            }
          },
        );

        server.registerTool(
          'rationalize',
          {
            description:
              'Rationalize an expression — clears denominators and produces a single fraction with polynomial numerator and denominator. Input in LaTeX format.',
            inputSchema: z.object({
              expression: z
                .string()
                .trim()
                .min(1)
                .describe(
                  'Expression in LaTeX, e.g. \\frac{2x}{y} - \\frac{y}{x+1}',
                ),
            }),
          },
          async (input) => {
            try {
              const result = rationalizeExpression(input.expression);
              return {
                content: [
                  {
                    type: 'text',
                    text: `Rationalized: ${result.result}\nLaTeX: ${result.latex}`,
                  },
                ],
              };
            } catch (error) {
              return errorContent(error);
            }
          },
        );

        return server;
      },
      { legacy: 'stateless' },
    );
  }

  fetch(request: Request): Promise<Response> {
    return this.#handler.fetch(request);
  }

  async close(): Promise<void> {
    await this.#handler.close();
  }
}

export function createCalculatorMcp(): CalculatorMcp {
  return new CalculatorMcpModule();
}

function errorContent(error: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

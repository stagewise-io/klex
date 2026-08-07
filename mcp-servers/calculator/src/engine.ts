import { all, create } from 'mathjs';

import { latexToMathjs } from './latex.js';

/**
 * Custom mathjs instance with `number: 'Fraction'` for exact arithmetic.
 * Rational expressions like 1/2 + 1/3 produce Fraction(5,6) instead of
 * 0.8333..., giving exact results for the evaluate tool.
 */
const math = create(all ?? {}, { number: 'Fraction' });

/**
 * Default-number instance for non-rational functions like sqrt, nthRoot,
 * trig, and log that cannot operate on Fraction values.
 */
const mathNum = create(all ?? {}, {});

export interface EngineResult {
  /** Human-readable result in mathjs plain-text syntax. */
  result: string;
  /** Result rendered as LaTeX for display. */
  latex: string;
}

export function evaluateExpression(
  expression: string,
  scope?: Record<string, number | string>,
): EngineResult {
  const expr = latexToMathjs(expression);
  const processedScope: Record<string, unknown> = {};

  if (scope) {
    for (const [key, value] of Object.entries(scope)) {
      processedScope[key] =
        typeof value === 'string' ? math.evaluate(latexToMathjs(value)) : value;
    }
  }

  let value: unknown;
  try {
    value = math.evaluate(expr, processedScope);
  } catch {
    // Non-rational functions (sqrt, nthRoot, trig, log) fail under
    // Fraction config — fall back to the default-number instance.
    value = mathNum.evaluate(expr, processedScope);
  }
  const resultStr = formatResult(math.format(value, { precision: 14 }));
  return { result: resultStr, latex: toLatex(resultStr) };
}

export function simplifyExpression(expression: string): EngineResult {
  const expr = latexToMathjs(expression);
  const node = math.simplify(expr);
  return { result: node.toString(), latex: node.toTex() };
}

export function differentiateExpression(
  expression: string,
  variable: string,
): EngineResult {
  const expr = latexToMathjs(expression);
  const node = math.derivative(expr, variable);
  return { result: node.toString(), latex: node.toTex() };
}

export function rationalizeExpression(expression: string): EngineResult {
  const expr = latexToMathjs(expression);
  const node = math.rationalize(expr);
  return { result: node.toString(), latex: node.toTex() };
}

/** Normalize mathjs Fraction output: 5/1 → 5, -3/1 → -3. */
function formatResult(formatted: string): string {
  return formatted.replace(/(-?\d+)\/1\b/g, '$1');
}

/** Convert a formatted result string back to LaTeX. */
function toLatex(formatted: string): string {
  try {
    return math.parse(formatted).toTex();
  } catch {
    return formatted;
  }
}

/** Exposed for solver.ts — returns coefficients of a polynomial. */
export function getPolynomialCoefficients(expression: string): {
  coefficients: number[];
  variables: string[];
} {
  const result = math.rationalize(expression, {}, true) as {
    coefficients: number[];
    variables: string[];
  };
  return { coefficients: result.coefficients, variables: result.variables };
}

/** Exposed for solver.ts — simplify fallback. */
export function simplifyFallback(expression: string): EngineResult {
  const node = math.simplify(expression);
  return { result: node.toString(), latex: node.toTex() };
}

/** Exposed for solver.ts — evaluate an expression numerically. */
export function evaluateNumeric(
  expression: string,
  variable: string,
  value: number,
): boolean {
  try {
    const result = mathNum.evaluate(expression, { [variable]: value });
    return (
      typeof result === 'number' &&
      !Number.isNaN(result) &&
      Number.isFinite(result)
    );
  } catch {
    return false;
  }
}

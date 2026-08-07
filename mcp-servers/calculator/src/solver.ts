import { getPolynomialCoefficients, simplifyFallback } from './engine.js';
import { latexToMathjs } from './latex.js';

export interface SolveResult {
  solutions: string[];
  latex: string[];
  type: 'exact' | 'numeric' | 'unsolved';
  message?: string;
}

export function solveEquation(equation: string, variable: string): SolveResult {
  const expr = latexToMathjs(equation);

  const parts = expr.split('=');
  if (parts.length !== 2) {
    throw new Error('Equation must contain exactly one equals sign (=)');
  }

  // Form f(x) - g(x) = 0
  const lhs = `(${parts[0]}) - (${parts[1]})`;

  try {
    const { coefficients, variables } = getPolynomialCoefficients(lhs);

    if (variables.length === 1 && variables[0] === variable) {
      return solvePolynomial(coefficients, variable);
    }

    if (variables.length === 0) {
      // Constant — identity (0=0) or contradiction (c=0, c≠0)
      if (coefficients[0] === 0) {
        return {
          solutions: [],
          latex: [],
          type: 'exact',
          message: 'Identity — all values are solutions',
        };
      }
      return {
        solutions: [],
        latex: [],
        type: 'exact',
        message: 'Contradiction — no solutions',
      };
    }

    // Multiple variables — cannot solve for a single variable
    const fallback = simplifyFallback(lhs);
    return {
      solutions: [`${fallback.result} = 0`],
      latex: [`${fallback.latex} = 0`],
      type: 'unsolved',
      message: `Equation contains variables ${variables.join(', ')}; cannot solve for ${variable} alone`,
    };
  } catch {
    // Not a rational/polynomial expression — return simplified form
    const fallback = simplifyFallback(lhs);
    return {
      solutions: [`${fallback.result} = 0`],
      latex: [`${fallback.latex} = 0`],
      type: 'unsolved',
      message: 'Equation is not a polynomial; simplified form shown',
    };
  }
}

function solvePolynomial(coeffs: number[], variable: string): SolveResult {
  // Coefficients from rationalize are [const, x, x², ...]
  // Remove trailing zeros (reduce degree)
  while (coeffs.length > 1 && coeffs[coeffs.length - 1] === 0) {
    coeffs.pop();
  }

  const degree = coeffs.length - 1;

  if (degree === 0) {
    if (coeffs[0] === 0) {
      return {
        solutions: [],
        latex: [],
        type: 'exact',
        message: 'Identity — all values are solutions',
      };
    }
    return { solutions: [], latex: [], type: 'exact', message: 'No solutions' };
  }

  if (degree === 1) {
    // ax + b = 0 → x = -b/a
    const a = coeffs[1] as number;
    const b = coeffs[0] as number;
    const x = -b / a;
    const sol = formatNum(x);
    return {
      solutions: [`${variable} = ${sol}`],
      latex: [`${variable} = ${sol}`],
      type: 'exact',
    };
  }

  if (degree === 2) {
    return solveQuadratic(coeffs, variable);
  }

  // Degree ≥ 3 — numeric root finding
  return solvePolynomialNumeric(coeffs, variable);
}

function solveQuadratic(coeffs: number[], variable: string): SolveResult {
  const a = coeffs[2] as number;
  const b = coeffs[1] as number;
  const c = coeffs[0] as number;
  const discriminant = b * b - 4 * a * c;

  if (discriminant > 0) {
    const sqrtD = Math.sqrt(discriminant);
    const x1 = (-b + sqrtD) / (2 * a);
    const x2 = (-b - sqrtD) / (2 * a);
    const s1 = formatNum(x1);
    const s2 = formatNum(x2);
    return {
      solutions: [`${variable} = ${s1}`, `${variable} = ${s2}`],
      latex: [`${variable} = ${s1}`, `${variable} = ${s2}`],
      type: 'exact',
    };
  }

  if (discriminant === 0) {
    const x = -b / (2 * a);
    const sol = formatNum(x);
    return {
      solutions: [`${variable} = ${sol}`],
      latex: [`${variable} = ${sol}`],
      type: 'exact',
    };
  }

  // Complex roots
  const realPart = -b / (2 * a);
  const imagPart = Math.sqrt(-discriminant) / (2 * a);
  const re = formatNum(realPart);
  const im = formatNum(imagPart);
  return {
    solutions: [`${variable} = ${re} + ${im}i`, `${variable} = ${re} - ${im}i`],
    latex: [`${variable} = ${re} + ${im}i`, `${variable} = ${re} - ${im}i`],
    type: 'exact',
  };
}

/**
 * Durand–Kerner method for finding all roots of a polynomial.
 * Works for any degree and finds both real and complex roots.
 */
function solvePolynomialNumeric(
  coeffs: number[],
  variable: string,
): SolveResult {
  const n = coeffs.length - 1;

  // Normalize: divide by leading coefficient
  const leading = coeffs[n] as number;
  const normalized = coeffs.map((c) => c / leading);

  // Initial guesses: points on a circle offset from origin
  const roots: Complex[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n + 0.4;
    roots.push({ re: 0.4 * Math.cos(angle), im: 0.4 * Math.sin(angle) });
  }

  const maxIter = 500;
  const tolerance = 1e-12;

  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const val = evalPoly(normalized, roots[i] as Complex);

      let denom: Complex = { re: 1, im: 0 };
      for (let j = 0; j < n; j++) {
        if (j !== i) {
          denom = mul(denom, sub(roots[i] as Complex, roots[j] as Complex));
        }
      }

      const delta = div(val, denom);
      roots[i] = sub(roots[i] as Complex, delta);
      maxDelta = Math.max(maxDelta, abs(delta));
    }
    if (maxDelta < tolerance) break;
  }

  const solutions = roots.map((r) => {
    if (Math.abs(r.im) < 1e-9) {
      return `${variable} = ${formatNum(r.re)}`;
    }
    if (Math.abs(r.re) < 1e-9) {
      return `${variable} = ${formatNum(r.im)}i`;
    }
    const sign = r.im > 0 ? '+' : '-';
    return `${variable} = ${formatNum(r.re)} ${sign} ${formatNum(Math.abs(r.im))}i`;
  });

  return {
    solutions,
    latex: solutions,
    type: 'numeric',
    message: `Degree ${n} polynomial — roots computed numerically`,
  };
}

// --- Complex number helpers ---

interface Complex {
  re: number;
  im: number;
}

function evalPoly(coeffs: number[], x: Complex): Complex {
  let result: Complex = { re: 0, im: 0 };
  for (let i = coeffs.length - 1; i >= 0; i--) {
    result = mul(result, x);
    result.re += coeffs[i] as number;
  }
  return result;
}

function mul(a: Complex, b: Complex): Complex {
  return {
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re,
  };
}

function sub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

function div(a: Complex, b: Complex): Complex {
  const denom = b.re * b.re + b.im * b.im;
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom,
  };
}

function abs(a: Complex): number {
  return Math.sqrt(a.re * a.re + a.im * a.im);
}

function formatNum(n: number): string {
  if (Math.abs(n - Math.round(n)) < 1e-9) {
    return String(Math.round(n));
  }
  return Number(n.toFixed(10)).toString();
}

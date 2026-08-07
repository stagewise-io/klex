import { describe, expect, it } from 'vitest';

import { solveEquation } from '../src/solver.js';

describe('solveEquation — linear', () => {
  it('solves x + 5 = 0', () => {
    const result = solveEquation('x + 5 = 0', 'x');
    expect(result.type).toBe('numeric');
    expect(result.solutions).toEqual(['x = -5']);
  });

  it('solves 2x + 3 = 7', () => {
    const result = solveEquation('2x + 3 = 7', 'x');
    expect(result.type).toBe('numeric');
    expect(result.solutions).toEqual(['x = 2']);
  });

  it('solves with LaTeX fractions', () => {
    const result = solveEquation('\\frac{x}{2} = 3', 'x');
    expect(result.type).toBe('numeric');
    expect(result.solutions.length).toBe(1);
    expect(result.solutions[0]).toBe('x = 6');
  });
});

describe('solveEquation — quadratic', () => {
  it('solves x^2 - 5x + 6 = 0 (two real roots)', () => {
    const result = solveEquation('x^2 - 5x + 6 = 0', 'x');
    expect(result.type).toBe('numeric');
    expect(result.solutions).toContain('x = 2');
    expect(result.solutions).toContain('x = 3');
  });

  it('solves x^2 - 4x + 4 = 0 (double root)', () => {
    const result = solveEquation('x^2 - 4x + 4 = 0', 'x');
    expect(result.type).toBe('numeric');
    expect(result.solutions).toEqual(['x = 2']);
  });

  it('solves x^2 + 1 = 0 (complex roots)', () => {
    const result = solveEquation('x^2 + 1 = 0', 'x');
    expect(result.type).toBe('numeric');
    expect(result.solutions).toHaveLength(2);
    expect(result.solutions[0]).toContain('i');
    expect(result.solutions[1]).toContain('i');
  });

  it('solves with LaTeX: \\frac{x^2}{4} = 1', () => {
    const result = solveEquation('\\frac{x^2}{4} = 1', 'x');
    expect(result.type).toBe('numeric');
    expect(result.solutions).toContain('x = 2');
    expect(result.solutions).toContain('x = -2');
  });

  it('uses stable formula for large linear coefficient', () => {
    const result = solveEquation('x^2 + 100000000 x + 1 = 0', 'x');
    expect(result.type).toBe('numeric');
    const values = result.solutions.map((s) =>
      Number.parseFloat(s.split('=')[1]?.trim() ?? ''),
    );
    // Small root should be ~ -1e-8, not catastrophically cancelled
    const small = values.find((v) => Math.abs(v) < 1) ?? 0;
    expect(Math.abs(small + 1e-8)).toBeLessThan(1e-9);
  });
});

describe('solveEquation — higher degree', () => {
  it('solves x^3 - 6x^2 + 11x - 6 = 0 numerically', () => {
    const result = solveEquation('x^3 - 6x^2 + 11x - 6 = 0', 'x');
    expect(result.type).toBe('numeric');
    expect(result.solutions).toHaveLength(3);
    // Roots are 1, 2, 3
    const values = result.solutions.map((s) =>
      Number.parseFloat(s.split('=')[1]?.trim() ?? ''),
    );
    expect(values).toContain(1);
    expect(values).toContain(2);
    expect(values).toContain(3);
  });
});

describe('solveEquation — edge cases', () => {
  it('rejects equations without =', () => {
    expect(() => solveEquation('x + 5', 'x')).toThrow('equals sign');
  });

  it('handles identity (0 = 0)', () => {
    const result = solveEquation('x - x = 0', 'x');
    expect(result.message).toContain('Identity');
  });

  it('handles contradiction', () => {
    const result = solveEquation('1 = 2', 'x');
    expect(result.message).toContain('Contradiction');
  });

  it('returns unsolved for multi-variable equations', () => {
    const result = solveEquation('2x + 3y = 7', 'x');
    expect(result.type).toBe('unsolved');
    expect(result.message).toContain('variables');
  });

  it('excludes denominator poles from solutions', () => {
    const result = solveEquation('\\frac{x^2 - 1}{x - 1} = 0', 'x');
    expect(result.solutions).toContain('x = -1');
    expect(result.solutions).not.toContain('x = 1');
  });
});

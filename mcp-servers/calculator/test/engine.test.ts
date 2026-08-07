import { describe, expect, it } from 'vitest';

import { evaluateExpression } from '../src/engine.js';

describe('evaluateExpression — arithmetic', () => {
  it('evaluates simple addition', () => {
    const result = evaluateExpression('1 + 2');
    expect(result.result).toBe('3');
  });

  it('evaluates fraction addition exactly', () => {
    const result = evaluateExpression('\\frac{1}{2} + \\frac{1}{3}');
    expect(result.result).toBe('5/6');
  });

  it('evaluates with variable scope', () => {
    const result = evaluateExpression('2x^2 + 3x + 4', { x: 5 });
    expect(result.result).toBe('69');
  });
});

describe('evaluateExpression — non-rational functions', () => {
  it('evaluates sqrt(2) without Fraction conversion error', () => {
    const result = evaluateExpression('\\sqrt{2}');
    expect(result.result).toContain('1.4142');
  });

  it('evaluates sqrt with variable scope', () => {
    const result = evaluateExpression('\\sqrt{x}', { x: 16 });
    expect(result.result).toBe('4');
  });

  it('evaluates nthRoot', () => {
    const result = evaluateExpression('\\sqrt[3]{27}');
    expect(result.result).toBe('3');
  });

  it('evaluates trig functions', () => {
    const result = evaluateExpression('\\sin(0)');
    expect(result.result).toBe('0');
  });

  it('evaluates nested frac inside sin', () => {
    const result = evaluateExpression('\\sin(\\frac{\\pi}{2})');
    expect(result.result).toBe('1');
  });
});

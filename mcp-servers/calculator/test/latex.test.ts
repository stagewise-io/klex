import { describe, expect, it } from 'vitest';

import { latexToMathjs } from '../src/latex.js';

describe('latexToMathjs — basic arithmetic', () => {
  it('passes through plain numbers and operators', () => {
    expect(latexToMathjs('1 + 2')).toBe('1 + 2');
    expect(latexToMathjs('3 * 4 - 5')).toBe('3 * 4 - 5');
  });

  it('converts implicit multiplication', () => {
    expect(latexToMathjs('2x')).toBe('2x');
    expect(latexToMathjs('2 x')).toBe('2 x');
  });
});

describe('latexToMathjs — fractions', () => {
  it('converts \\frac{a}{b}', () => {
    expect(latexToMathjs('\\frac{1}{2}')).toBe('(1) / (2)');
  });

  it('handles nested fractions', () => {
    expect(latexToMathjs('\\frac{1}{\\frac{1}{2}}')).toBe('(1) / ((1) / (2))');
  });

  it('handles fractions with expressions', () => {
    expect(latexToMathjs('\\frac{x^2 - 1}{x - 1}')).toBe('(x^2 - 1) / (x - 1)');
  });

  it('handles \\dfrac and \\tfrac', () => {
    expect(latexToMathjs('\\dfrac{3}{4}')).toBe('(3) / (4)');
    expect(latexToMathjs('\\tfrac{5}{6}')).toBe('(5) / (6)');
  });
});

describe('latexToMathjs — roots', () => {
  it('converts \\sqrt{x}', () => {
    expect(latexToMathjs('\\sqrt{x}')).toBe('sqrt(x)');
  });

  it('converts \\sqrt{x+1}', () => {
    expect(latexToMathjs('\\sqrt{x+1}')).toBe('sqrt(x+1)');
  });

  it('converts \\sqrt[n]{x}', () => {
    expect(latexToMathjs('\\sqrt[3]{x}')).toBe('nthRoot(x, 3)');
  });
});

describe('latexToMathjs — functions', () => {
  it('converts trig functions', () => {
    expect(latexToMathjs('\\sin(x)')).toBe('sin(x)');
    expect(latexToMathjs('\\cos(x)')).toBe('cos(x)');
    expect(latexToMathjs('\\tan(x)')).toBe('tan(x)');
  });

  it('converts inverse trig', () => {
    expect(latexToMathjs('\\arcsin(x)')).toBe('asin(x)');
    expect(latexToMathjs('\\arccos(x)')).toBe('acos(x)');
  });

  it('handles \\sin^2(x)', () => {
    expect(latexToMathjs('\\sin^2(x)')).toBe('(sin(x))^(2)');
  });

  it('handles function without parentheses', () => {
    expect(latexToMathjs('\\sin x')).toBe('sin(x)');
  });

  it('converts \\ln and \\log', () => {
    expect(latexToMathjs('\\ln(x)')).toBe('log(x)');
    expect(latexToMathjs('\\log(x)')).toBe('log10(x)');
  });

  it('converts \\log_{base}{x}', () => {
    expect(latexToMathjs('\\log_{2}{x}')).toBe('log(x, 2)');
  });

  it('converts \\exp and \\abs', () => {
    expect(latexToMathjs('\\exp{x}')).toBe('exp(x)');
    expect(latexToMathjs('\\abs{x}')).toBe('abs(x)');
  });
});

describe('latexToMathjs — constants and Greek', () => {
  it('converts \\pi and \\infty', () => {
    expect(latexToMathjs('\\pi')).toBe('pi');
    expect(latexToMathjs('\\infty')).toBe('Infinity');
  });

  it('converts Greek letters', () => {
    expect(latexToMathjs('\\theta')).toBe('theta');
    expect(latexToMathjs('\\alpha + \\beta')).toBe('alpha + beta');
    expect(latexToMathjs('\\Delta')).toBe('Delta');
  });
});

describe('latexToMathjs — operators and delimiters', () => {
  it('converts \\cdot, \\times, \\div', () => {
    expect(latexToMathjs('2 \\cdot 3')).toBe('2 * 3');
    expect(latexToMathjs('2 \\times 3')).toBe('2 * 3');
    expect(latexToMathjs('6 \\div 2')).toBe('6 / 2');
  });

  it('strips \\left and \\right', () => {
    expect(latexToMathjs('\\left( x + 1 \\right)')).toBe('( x + 1 )');
  });
});

describe('latexToMathjs — superscripts and subscripts', () => {
  it('passes through simple superscripts', () => {
    expect(latexToMathjs('x^2')).toBe('x^2');
  });

  it('converts braced superscripts', () => {
    expect(latexToMathjs('x^{2y}')).toBe('x^(2y)');
  });

  it('converts braced subscripts', () => {
    expect(latexToMathjs('x_{ij}')).toBe('x_(ij)');
  });
});

describe('latexToMathjs — complex expressions', () => {
  it('handles \\pi r^2', () => {
    expect(latexToMathjs('\\pi r^2')).toBe('pi r^2');
  });

  it('handles quadratic formula input', () => {
    expect(latexToMathjs('x^2 - 5x + 6')).toBe('x^2 - 5x + 6');
  });

  it('handles e^{x}', () => {
    expect(latexToMathjs('e^{x}')).toBe('e^(x)');
  });

  it('handles \\frac{\\sin(x)}{x}', () => {
    expect(latexToMathjs('\\frac{\\sin(x)}{x}')).toBe('(sin(x)) / (x)');
  });
});

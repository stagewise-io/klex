/**
 * LaTeX → mathjs expression converter.
 *
 * Uses a scanner-based approach that handles nested constructs
 * (fractions, roots, function arguments) via recursive group parsing.
 *
 * Supported LaTeX:
 *   \frac{a}{b}, \dfrac, \tfrac, \binom{n}{k}
 *   \sqrt{x}, \sqrt[n]{x}
 *   \sin, \cos, \tan, \sec, \csc, \cot
 *   \arcsin, \arccos, \arctan, \sinh, \cosh, \tanh
 *   \log_{base}{x}, \log{x}, \ln{x}, \lg{x}, \exp{x}, \abs{x}
 *   \pi, \infty, Greek letters (α–ω, Α–Ω)
 *   \cdot, \times, \div, \left, \right
 *   ^{...}, _{...}, |x| (absolute value bars)
 *
 * Limitations:
 *   No \sum, \int, \lim, \prod (calculus notation)
 *   No matrices or piecewise functions
 *   No \pm (plus-minus)
 */

const GREEK: Record<string, string> = {
  alpha: 'alpha',
  beta: 'beta',
  gamma: 'gamma',
  delta: 'delta',
  epsilon: 'epsilon',
  varepsilon: 'epsilon',
  zeta: 'zeta',
  eta: 'eta',
  theta: 'theta',
  vartheta: 'theta',
  iota: 'iota',
  kappa: 'kappa',
  lambda: 'lambda',
  mu: 'mu',
  nu: 'nu',
  xi: 'xi',
  pi: 'pi',
  varpi: 'pi',
  rho: 'rho',
  varrho: 'rho',
  sigma: 'sigma',
  varsigma: 'sigma',
  tau: 'tau',
  upsilon: 'upsilon',
  phi: 'phi',
  varphi: 'phi',
  chi: 'chi',
  psi: 'psi',
  omega: 'omega',
  Gamma: 'Gamma',
  Delta: 'Delta',
  Theta: 'Theta',
  Lambda: 'Lambda',
  Xi: 'Xi',
  Pi: 'Pi',
  Sigma: 'Sigma',
  Upsilon: 'Upsilon',
  Phi: 'Phi',
  Psi: 'Psi',
  Omega: 'Omega',
};

const FUNCS: Record<string, string> = {
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  sec: 'sec',
  csc: 'csc',
  cot: 'cot',
  arcsin: 'asin',
  arccos: 'acos',
  arctan: 'atan',
  sinh: 'sinh',
  cosh: 'cosh',
  tanh: 'tanh',
  floor: 'floor',
  ceil: 'ceil',
  gcd: 'gcd',
  lcm: 'lcm',
};

const CONSTANTS: Record<string, string> = {
  pi: 'pi',
  infty: 'Infinity',
};

/** Commands that take no arguments and are stripped from output. */
const STRIP = new Set([
  'left',
  'right',
  'displaystyle',
  'textstyle',
  'scriptstyle',
  'scriptscriptstyle',
  'big',
  'Big',
  'bigg',
  'Bigg',
  'bigl',
  'bigr',
  'Bigl',
  'Bigr',
]);

/** Spacing commands — replaced with a single space. */
const SPACING = new Set([
  ',',
  '!',
  ';',
  ':',
  'quad',
  'qquad',
  'thinspace',
  'medspace',
  'thickspace',
]);

export function latexToMathjs(latex: string): string {
  return new Converter(latex).convert();
}

class Converter {
  readonly #input: string;
  #pos: number;

  constructor(input: string) {
    this.#input = input;
    this.#pos = 0;
  }

  convert(): string {
    const result = this.#parseSequence();
    return result.trim().replace(/\s+/g, ' ');
  }

  #parseSequence(stop?: string): string {
    let out = '';
    while (this.#pos < this.#input.length) {
      const ch = this.#input[this.#pos] as string;
      if (stop?.includes(ch)) break;

      if (/\s/.test(ch)) {
        this.#pos++;
        out += ' ';
        continue;
      }

      if (ch === '\\') {
        out += this.#parseCommand();
        continue;
      }

      if (ch === '{') {
        out += `(${this.#parseGroup()})`;
        continue;
      }

      if (ch === '^' || ch === '_') {
        out += this.#parseSupOrSub(ch);
        continue;
      }

      if (ch === '|') {
        out += this.#parseAbsBar();
        continue;
      }

      // All other characters pass through
      out += ch;
      this.#pos++;
    }
    return out;
  }

  #parseGroup(): string {
    // Assumes current char is '{'
    this.#pos++; // skip '{'
    const content = this.#parseSequence('}');
    if (this.#input[this.#pos] === '}') this.#pos++;
    return content;
  }

  #parseBracketOpt(): string | null {
    this.#skipSpace();
    if (this.#input[this.#pos] !== '[') return null;
    this.#pos++; // skip '['
    let depth = 1;
    const start = this.#pos;
    while (this.#pos < this.#input.length && depth > 0) {
      const ch = this.#input[this.#pos] as string;
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) break;
      }
      this.#pos++;
    }
    const content = this.#input.slice(start, this.#pos);
    if (this.#input[this.#pos] === ']') this.#pos++;
    return content;
  }

  #parseSupOrSub(marker: string): string {
    this.#pos++; // skip ^ or _
    this.#skipSpace();
    if (this.#input[this.#pos] === '{') {
      return `${marker}(${this.#parseGroup()})`;
    }
    if (this.#input[this.#pos] === '\\') {
      return `${marker}(${this.#parseCommand()})`;
    }
    if (this.#pos < this.#input.length) {
      const ch = this.#input[this.#pos] as string;
      this.#pos++;
      return `${marker}${ch}`;
    }
    return '';
  }

  /** Handle |...| as abs(...) — tracks bar state via a stack. */
  #parseAbsBar(): string {
    // First bar opens abs(, second bar closes )
    // We use a simple toggle — nested bars are not supported
    if (this.#absOpen) {
      this.#absOpen = false;
      this.#pos++;
      return ')';
    }
    this.#absOpen = true;
    this.#pos++;
    return 'abs(';
  }

  #absOpen = false;

  #parseCommand(): string {
    this.#pos++; // skip backslash
    let name = '';

    // Non-letter commands: \!, \,, \;, \: — spacing commands
    // that use symbols instead of names.
    const sym = this.#input[this.#pos] as string;
    if (sym === '!' || sym === ',' || sym === ';' || sym === ':') {
      this.#pos++;
      return ' ';
    }

    while (
      this.#pos < this.#input.length &&
      /[a-zA-Z]/.test(this.#input[this.#pos] as string)
    ) {
      name += this.#input[this.#pos];
      this.#pos++;
    }

    // Spacing commands — consume and return a space
    if (SPACING.has(name)) return ' ';

    // Strip commands
    if (STRIP.has(name)) return '';

    // Operators
    if (name === 'cdot' || name === 'times' || name === 'ast') return '*';
    if (name === 'div') return '/';

    // Relational operators
    if (name === 'le' || name === 'leq') return '<=';
    if (name === 'ge' || name === 'geq') return '>=';
    if (name === 'ne' || name === 'neq') return '!=';
    if (name === 'll') return '<<';
    if (name === 'gg') return '>>';

    // \frac, \dfrac, \tfrac
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      this.#skipSpace();
      const num = this.#parseFunctionArg();
      this.#skipSpace();
      const den = this.#parseFunctionArg();
      return `((${num}) / (${den}))`;
    }

    // \binom{n}{k} = n! / (k! * (n-k)!)
    if (name === 'binom') {
      this.#skipSpace();
      const n = this.#parseFunctionArg();
      this.#skipSpace();
      const k = this.#parseFunctionArg();
      return `(${n})! / ((${k})! * ((${n}) - (${k}))!)`;
    }

    // \sqrt[n]{x} or \sqrt{x}
    if (name === 'sqrt') {
      const n = this.#parseBracketOpt();
      this.#skipSpace();
      const arg = this.#parseFunctionArg();
      if (n !== null) return `nthRoot(${arg}, ${n})`;
      return `sqrt(${arg})`;
    }

    // \log_{base}{x}, \log{x}, \lg{x}
    if (name === 'log' || name === 'lg') {
      this.#skipSpace();
      if (this.#input[this.#pos] === '_') {
        this.#pos++;
        this.#skipSpace();
        const base = this.#parseAtom();
        this.#skipSpace();
        const arg = this.#parseFunctionArg();
        return `log(${arg}, ${base})`;
      }
      const arg = this.#parseFunctionArg();
      return `log10(${arg})`;
    }

    // \ln{x} → log(x) (natural log in mathjs)
    if (name === 'ln') {
      const arg = this.#parseFunctionArg();
      return `log(${arg})`;
    }

    // \exp{x} → exp(x)
    if (name === 'exp') {
      const arg = this.#parseFunctionArg();
      return `exp(${arg})`;
    }

    // \abs{x} → abs(x)
    if (name === 'abs') {
      const arg = this.#parseFunctionArg();
      return `abs(${arg})`;
    }

    // Trig and other known functions
    if (FUNCS[name]) {
      const fn = FUNCS[name] as string;
      this.#skipSpace();
      // Handle \sin^2(x) → (sin(x))^2
      if (this.#input[this.#pos] === '^') {
        this.#pos++;
        this.#skipSpace();
        const exp = this.#parseAtom();
        this.#skipSpace();
        const arg = this.#parseFunctionArg();
        return `(${fn}(${arg}))^(${exp})`;
      }
      // \left / \right and other strip-only commands before the argument
      // e.g. \cos\left(2\cdot x\right) → cos(2 * x)
      this.#consumeStripCommands();
      const arg = this.#parseFunctionArg();
      return `${fn}(${arg})`;
    }

    // Greek letters
    if (GREEK[name]) return GREEK[name] as string;

    // Constants
    if (CONSTANTS[name]) return CONSTANTS[name] as string;

    // Unknown command — return name as-is (may work in mathjs)
    return name;
  }

  /** Parse a single atom: group, command, or number/identifier. */
  #parseAtom(): string {
    this.#skipSpace();
    if (this.#input[this.#pos] === '{') return this.#parseGroup();
    if (this.#input[this.#pos] === '\\') return this.#parseCommand();
    let result = '';
    while (
      this.#pos < this.#input.length &&
      /[a-zA-Z0-9.]/.test(this.#input[this.#pos] as string)
    ) {
      result += this.#input[this.#pos];
      this.#pos++;
    }
    return result;
  }

  /** Parse a function argument: {x}, (x), \command, or single atom. */
  #parseFunctionArg(): string {
    this.#skipSpace();
    const ch = this.#input[this.#pos];
    if (ch === '{') return this.#parseGroup();
    if (ch === '(') {
      // Read the full parenthesized group, then strip outer parens
      // so function wrappers don't double-wrap: sin((x)) → sin(x)
      let depth = 0;
      const start = this.#pos;
      while (this.#pos < this.#input.length) {
        const c = this.#input[this.#pos] as string;
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) {
            this.#pos++;
            break;
          }
        }
        this.#pos++;
      }
      // Recursively convert the inner content so nested LaTeX
      // commands like \sin(\frac{1}{2}) are properly converted
      const inner = this.#input.slice(start + 1, this.#pos - 1);
      return new Converter(inner).convert();
    }
    if (ch === '\\') return this.#parseCommand();
    // Single character or number
    let result = '';
    while (
      this.#pos < this.#input.length &&
      /[a-zA-Z0-9.]/.test(this.#input[this.#pos] as string)
    ) {
      result += this.#input[this.#pos];
      this.#pos++;
    }
    return result;
  }

  #skipSpace(): void {
    while (
      this.#pos < this.#input.length &&
      /\s/.test(this.#input[this.#pos] as string)
    ) {
      this.#pos++;
    }
  }

  /** Consume consecutive strip-only commands (\left, \right, \big, etc.). */
  #consumeStripCommands(): void {
    let prev = this.#pos;
    for (;;) {
      this.#skipSpace();
      if (this.#input[this.#pos] !== '\\') break;
      const saved = this.#pos;
      this.#pos++; // skip backslash
      let name = '';
      while (
        this.#pos < this.#input.length &&
        /[a-zA-Z]/.test(this.#input[this.#pos] as string)
      ) {
        name += this.#input[this.#pos];
        this.#pos++;
      }
      if (!STRIP.has(name)) {
        // Not a strip command — restore position and stop
        this.#pos = saved;
        break;
      }
      prev = this.#pos;
    }
    this.#pos = prev;
  }
}

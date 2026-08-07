# Calculator MCP Server

A symbolic and numeric calculator MCP server for klex. Accepts mathematical expressions in LaTeX format and returns results in both plain-text and LaTeX.

Powered by [mathjs](https://mathjs.org/) for exact arithmetic (fractions), symbolic simplification, differentiation, rationalization, and polynomial root finding.

## Start

```sh
pnpm --filter @stagewise/calculator dev
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3125` | HTTP port |
| `LOG_LEVEL` | `INFO` | Structured log threshold |

`GET /health` returns `{ "status": "ok" }`. All MCP traffic goes through `POST /mcp`.

## Tools

### `evaluate`

Evaluate a mathematical expression. Supports arithmetic, fractions, functions, and variable substitution.

```json
{
  "expression": "\\frac{1}{2} + \\frac{1}{3}",
  "scope": {}
}
```

```
Result: 5/6
LaTeX: \frac{5}{6}
```

With variable scope:

```json
{
  "expression": "2x^2 + 3x + 4",
  "scope": { "x": 5 }
}
```

```
Result: 69
LaTeX: 69
```

Scope values can be numbers or LaTeX strings (`{ "x": "\\frac{1}{2}" }`).

### `simplify`

Algebraically simplify an expression.

```json
{ "expression": "2x + 3x" }
```

```
Simplified: 5 * x
LaTeX: 5 \cdot x
```

### `differentiate`

Compute the symbolic derivative with respect to a variable.

```json
{ "expression": "\\sin(2x)", "variable": "x" }
```

```
Derivative: 2 * cos(2 * x)
LaTeX: 2 \cdot \cos\left(2 \cdot x\right)
```

### `solve`

Solve an equation for a variable. Handles:

- **Linear**: `ax + b = 0` → exact solution
- **Quadratic**: `ax² + bx + c = 0` → quadratic formula (real and complex roots)
- **Higher degree** (≥ 3): numeric root finding via the Durand–Kerner method
- **Non-polynomial**: simplified form returned

```json
{ "equation": "x^2 - 5x + 6 = 0", "variable": "x" }
```

```
Solutions (exact):
  1. x = 2
  2. x = 3

LaTeX:
  1. x = 2
  2. x = 3
```

### `rationalize`

Clear denominators and produce a single fraction with polynomial numerator and denominator.

```json
{ "expression": "\\frac{2x}{y} - \\frac{y}{x+1}" }
```

```
Rationalized: (2 * x ^ 2 - y ^ 2 + 2 * x) / (x * y + y)
LaTeX: \frac{2 \cdot x^{2} - y^{2} + 2 \cdot x}{x \cdot y + y}
```

## Supported LaTeX

| Category | Input | mathjs equivalent |
| --- | --- | --- |
| Fractions | `\frac{a}{b}`, `\dfrac`, `\tfrac` | `(a) / (b)` |
| Binomial | `\binom{n}{k}` | `n! / (k! * (n-k)!)` |
| Roots | `\sqrt{x}`, `\sqrt[n]{x}` | `sqrt(x)`, `nthRoot(x, n)` |
| Trig | `\sin`, `\cos`, `\tan`, `\sec`, `\csc`, `\cot` | `sin`, `cos`, ... |
| Inverse trig | `\arcsin`, `\arccos`, `\arctan` | `asin`, `acos`, `atan` |
| Hyperbolic | `\sinh`, `\cosh`, `\tanh` | `sinh`, `cosh`, `tanh` |
| Logarithm | `\ln{x}`, `\log{x}`, `\log_{2}{x}` | `log(x)`, `log10(x)`, `log(x, 2)` |
| Exp/Abs | `\exp{x}`, `\abs{x}` | `exp(x)`, `abs(x)` |
| Constants | `\pi`, `\infty` | `pi`, `Infinity` |
| Greek | `\alpha`, `\theta`, `\Delta`, ... | `alpha`, `theta`, `Delta`, ... |
| Operators | `\cdot`, `\times`, `\div` | `*`, `*`, `/` |
| Delimiters | `\left(`, `\right)`, `\left|`, `\right|` | `(`, `)`, `abs(`, `)` |
| Superscript | `x^2`, `x^{2y}` | `x^2`, `x^(2y)` |
| Subscript | `x_1`, `x_{ij}` | `x_1`, `x_(ij)` |

### Limitations

- No `\sum`, `\int`, `\lim`, `\prod` (calculus notation)
- No matrices or piecewise functions
- No `\pm` (plus-minus)
- Nested absolute value bars `\|x| - |y\|` are not supported — use `\abs{x}` instead

## Connect an agent

```json
{
  "transport": "http",
  "url": "http://localhost:3125/mcp"
}
```

No credentials required. The server is stateless — each request is independent.

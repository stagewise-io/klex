import { describe, expect, it } from 'vitest';

// Test the port validation logic without importing the module
// (which starts a server on import).

function validatePort(raw: string | undefined): number {
  const port = Number(raw ?? 3125);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT: ${raw ?? port}. Must be an integer in range 1–65535.`,
    );
  }
  return port;
}

describe('PORT validation', () => {
  it('accepts default port', () => {
    expect(validatePort(undefined)).toBe(3125);
  });

  it('accepts valid port', () => {
    expect(validatePort('8080')).toBe(8080);
  });

  it('accepts port 1', () => {
    expect(validatePort('1')).toBe(1);
  });

  it('accepts port 65535', () => {
    expect(validatePort('65535')).toBe(65535);
  });

  it('rejects port 0', () => {
    expect(() => validatePort('0')).toThrow('Invalid PORT');
  });

  it('rejects negative port', () => {
    expect(() => validatePort('-1')).toThrow('Invalid PORT');
  });

  it('rejects port above 65535', () => {
    expect(() => validatePort('99999')).toThrow('Invalid PORT');
  });

  it('rejects non-numeric port', () => {
    expect(() => validatePort('abc')).toThrow('Invalid PORT');
  });

  it('rejects empty string', () => {
    expect(() => validatePort('')).toThrow('Invalid PORT');
  });
});

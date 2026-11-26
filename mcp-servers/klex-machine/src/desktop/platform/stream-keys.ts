import type { StreamKey } from '../rfb/backend.js';

// Viewers send XT (PC set 1) scan codes through the QEMU extended key event,
// with E0-prefixed codes as `code | 0x80`, as noVNC does. A physical code wins
// over the keysym so the desktop's own layout decides what a key types.

// XT scan code to macOS virtual key code (kVK_* in Carbon's Events.h).
const MACOS_BY_XT: Record<number, number> = {
  1: 53, // Escape
  2: 18,
  3: 19,
  4: 20,
  5: 21,
  6: 23,
  7: 22,
  8: 26,
  9: 28,
  10: 25,
  11: 29,
  12: 27, // Minus
  13: 24, // Equal
  14: 51, // Backspace
  15: 48, // Tab
  16: 12,
  17: 13,
  18: 14,
  19: 15,
  20: 17,
  21: 16,
  22: 32,
  23: 34,
  24: 31,
  25: 35,
  26: 33, // BracketLeft
  27: 30, // BracketRight
  28: 36, // Enter
  29: 59, // ControlLeft
  30: 0,
  31: 1,
  32: 2,
  33: 3,
  34: 5,
  35: 4,
  36: 38,
  37: 40,
  38: 37,
  39: 41, // Semicolon
  40: 39, // Quote
  41: 50, // Backquote
  42: 56, // ShiftLeft
  43: 42, // Backslash
  44: 6,
  45: 7,
  46: 8,
  47: 9,
  48: 11,
  49: 45,
  50: 46,
  51: 43, // Comma
  52: 47, // Period
  53: 44, // Slash
  54: 60, // ShiftRight
  55: 67, // NumpadMultiply
  56: 58, // AltLeft
  57: 49, // Space
  58: 57, // CapsLock
  59: 122, // F1
  60: 120,
  61: 99,
  62: 118,
  63: 96,
  64: 97,
  65: 98,
  66: 100,
  67: 101,
  68: 109, // F10
  69: 71, // NumLock, Clear on Mac keypads
  71: 89, // Numpad7
  72: 91,
  73: 92,
  74: 78, // NumpadSubtract
  75: 86,
  76: 87,
  77: 88,
  78: 69, // NumpadAdd
  79: 83,
  80: 84,
  81: 85,
  82: 82, // Numpad0
  83: 65, // NumpadDecimal
  84: 105, // PrintScreen, F13 on Mac keyboards
  85: 106, // F16
  86: 10, // IntlBackslash, the ISO section key
  87: 103, // F11
  88: 111, // F12
  89: 81, // NumpadEqual
  90: 90, // F20
  93: 105, // F13
  94: 107, // F14
  95: 113, // F15
  112: 104, // KanaMode
  113: 102, // Lang2, Eisu
  114: 104, // Lang1, Kana
  115: 94, // IntlRo
  125: 93, // IntlYen
  126: 95, // NumpadComma
  131: 64, // F17
  132: 80, // F19
  156: 76, // NumpadEnter
  157: 62, // ControlRight
  160: 74, // AudioVolumeMute
  174: 73, // AudioVolumeDown
  176: 72, // AudioVolumeUp
  181: 75, // NumpadDivide
  184: 61, // AltRight
  199: 115, // Home
  200: 126, // ArrowUp
  201: 116, // PageUp
  203: 123, // ArrowLeft
  205: 124, // ArrowRight
  207: 119, // End
  208: 125, // ArrowDown
  209: 121, // PageDown
  210: 114, // Insert, Help on Mac keyboards
  211: 117, // Delete
  219: 55, // MetaLeft, Command
  220: 54, // MetaRight
  221: 110, // ContextMenu
  245: 114, // Help
  247: 79, // F18
};

// X keysyms for keys without a printable character.
const MACOS_BY_KEYSYM: Record<number, number> = {
  65288: 51, // BackSpace
  65289: 48, // Tab
  65293: 36, // Return
  65307: 53, // Escape
  65535: 117, // Delete
  65360: 115, // Home
  65361: 123, // Left
  65362: 126, // Up
  65363: 124, // Right
  65364: 125, // Down
  65365: 116, // Prior
  65366: 121, // Next
  65367: 119, // End
  65379: 114, // Insert
  65386: 114, // Help
  65421: 76, // KP_Enter
  65505: 56, // Shift_L
  65506: 60, // Shift_R
  65507: 59, // Control_L
  65508: 62, // Control_R
  65509: 57, // Caps_Lock
  65511: 55, // Meta_L
  65512: 54, // Meta_R
  65513: 58, // Alt_L
  65514: 61, // Alt_R
  65515: 55, // Super_L
  65516: 54, // Super_R
  65027: 61, // ISO_Level3_Shift (AltGr)
  32: 49, // space
};

const MACOS_FUNCTION_KEYS = [
  122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106,
  64, 79, 80, 90,
];

// US ANSI positions for printable ASCII keysyms, used only without a scan code.
const MACOS_BY_ASCII: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  '1': 18,
  '2': 19,
  '3': 20,
  '4': 21,
  '6': 22,
  '5': 23,
  '=': 24,
  '9': 25,
  '7': 26,
  '-': 27,
  '8': 28,
  '0': 29,
  ']': 30,
  o: 31,
  u: 32,
  '[': 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ';': 41,
  '\\': 42,
  ',': 43,
  '/': 44,
  n: 45,
  m: 46,
  '.': 47,
  '`': 50,
  '!': 18,
  '@': 19,
  '#': 20,
  $: 21,
  '^': 22,
  '%': 23,
  '+': 24,
  '(': 25,
  '&': 26,
  _: 27,
  '*': 28,
  ')': 29,
  '}': 30,
  '{': 33,
  '"': 39,
  ':': 41,
  '|': 42,
  '<': 43,
  '?': 44,
  '>': 47,
  '~': 50,
};

// Windows set 1 scan codes differ from the XT codes noVNC sends for a few keys.
const WINDOWS_BY_XT: Record<number, string> = {
  69: 'e45', // NumLock is extended for SendInput
  84: 'e37', // PrintScreen
  93: 's64', // F13
  94: 's65', // F14
  95: 's66', // F15
  85: 's67', // F16
  131: 's68', // F17
  247: 's69', // F18
  132: 's6a', // F19
  90: 's6b', // F20
  198: 'v13', // Pause has no single scan code
};

// Virtual-key codes for keysyms without a printable character.
const WINDOWS_BY_KEYSYM: Record<number, number> = {
  65288: 0x08, // BackSpace
  65289: 0x09, // Tab
  65293: 0x0d, // Return
  65299: 0x13, // Pause
  65300: 0x91, // Scroll_Lock
  65307: 0x1b, // Escape
  65535: 0x2e, // Delete
  65360: 0x24, // Home
  65361: 0x25, // Left
  65362: 0x26, // Up
  65363: 0x27, // Right
  65364: 0x28, // Down
  65365: 0x21, // Prior
  65366: 0x22, // Next
  65367: 0x23, // End
  65377: 0x2c, // Print
  65379: 0x2d, // Insert
  65383: 0x5d, // Menu
  65407: 0x90, // Num_Lock
  65421: 0x0d, // KP_Enter
  65505: 0xa0, // Shift_L
  65506: 0xa1, // Shift_R
  65507: 0xa2, // Control_L
  65508: 0xa3, // Control_R
  65509: 0x14, // Caps_Lock
  65511: 0x5b, // Meta_L
  65512: 0x5c, // Meta_R
  65513: 0xa4, // Alt_L
  65514: 0xa5, // Alt_R
  65515: 0x5b, // Super_L
  65516: 0x5c, // Super_R
  65027: 0xa5, // ISO_Level3_Shift (AltGr)
};

const hex = (value: number) => value.toString(16);

/** The Unicode code point a keysym types, if it is a character. */
export function keysymCodePoint(keysym: number): number | undefined {
  if ((keysym >= 0x20 && keysym <= 0x7e) || (keysym >= 0xa0 && keysym <= 0xff))
    return keysym;
  if (keysym >= 0x01000100 && keysym <= 0x0110ffff) return keysym - 0x01000000;
  return undefined;
}

function functionKey(keysym: number): number | undefined {
  // XK_F1 to XK_F24.
  return keysym >= 0xffbe && keysym <= 0xffd5 ? keysym - 0xffbe + 1 : undefined;
}

/** The macOS stream helper's token for a key: `k<kVK>` or `u<code point>`. */
export function macosKeyToken(key: StreamKey): string | undefined {
  const byCode = key.keycode ? MACOS_BY_XT[key.keycode] : undefined;
  if (byCode !== undefined) return `k${hex(byCode)}`;
  const named = MACOS_BY_KEYSYM[key.keysym];
  if (named !== undefined) return `k${hex(named)}`;
  const fn = functionKey(key.keysym);
  if (fn !== undefined) {
    const code = MACOS_FUNCTION_KEYS[fn - 1];
    return code === undefined ? undefined : `k${hex(code)}`;
  }
  const codePoint = keysymCodePoint(key.keysym);
  if (codePoint === undefined) return undefined;
  const ascii = MACOS_BY_ASCII[String.fromCodePoint(codePoint).toLowerCase()];
  if (ascii !== undefined) return `k${hex(ascii)}`;
  return `u${hex(codePoint)}`;
}

/**
 * The Windows stream helper's token for a key: a set 1 scan code `s<code>`,
 * an extended one `e<code>`, a virtual key `v<code>` or a character
 * `u<code point>`.
 */
export function windowsKeyToken(key: StreamKey): string | undefined {
  const code = key.keycode;
  if (code > 0 && code < 0x100) {
    const special = WINDOWS_BY_XT[code];
    if (special) return special;
    return code & 0x80 ? `e${hex(code & 0x7f)}` : `s${hex(code)}`;
  }
  const named = WINDOWS_BY_KEYSYM[key.keysym];
  if (named !== undefined) return `v${hex(named)}`;
  const fn = functionKey(key.keysym);
  if (fn !== undefined) return `v${hex(0x70 + fn - 1)}`;
  const codePoint = keysymCodePoint(key.keysym);
  return codePoint === undefined ? undefined : `u${hex(codePoint)}`;
}

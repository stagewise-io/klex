//! macOS key names, chords and viewer key mapping. Pure tables, so they are
//! tested on every platform.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use crate::desktop::rfb::StreamKey;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Modifier {
    Cmd,
    Ctrl,
    Alt,
    Shift,
    Fn,
}

impl Modifier {
    /// Virtual key code of the left-hand key (`kVK_*`).
    pub fn key_code(self) -> u16 {
        match self {
            Self::Cmd => 55,
            Self::Shift => 56,
            Self::Alt => 58,
            Self::Ctrl => 59,
            Self::Fn => 63,
        }
    }

    /// `CGEventFlags` mask.
    pub fn flag(self) -> u64 {
        match self {
            Self::Shift => 0x0002_0000,
            Self::Ctrl => 0x0004_0000,
            Self::Alt => 0x0008_0000,
            Self::Cmd => 0x0010_0000,
            Self::Fn => 0x0080_0000,
        }
    }
}

fn modifier(name: &str) -> Option<Modifier> {
    Some(match name.to_lowercase().as_str() {
        "cmd" | "command" | "super" | "meta" | "win" => Modifier::Cmd,
        "ctrl" | "control" => Modifier::Ctrl,
        "alt" | "option" | "opt" => Modifier::Alt,
        "shift" => Modifier::Shift,
        "fn" => Modifier::Fn,
        _ => return None,
    })
}

pub fn to_modifier(name: &str) -> Result<Modifier, String> {
    modifier(name).ok_or_else(|| format!("Unsupported modifier: {name}"))
}

/// Modifiers in first-seen order without repeats.
pub fn to_modifiers(names: &[String]) -> Result<Vec<Modifier>, String> {
    let mut held = Vec::new();
    for name in names {
        let modifier = to_modifier(name)?;
        if !held.contains(&modifier) {
            held.push(modifier);
        }
    }
    Ok(held)
}

/// F1 to F20.
const FUNCTION_KEY_CODES: [u16; 20] = [
    122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
];

fn named_key_code(name: &str) -> Option<u16> {
    Some(match name {
        "enter" | "return" => 36,
        "tab" => 48,
        "space" => 49,
        "backspace" => 51,
        "esc" | "escape" => 53,
        "capslock" => 57,
        "insert" | "help" => 114,
        "home" => 115,
        "pageup" | "page_up" => 116,
        "delete" | "del" => 117,
        "end" => 119,
        "pagedown" | "page_down" => 121,
        "left" | "arrowleft" => 123,
        "right" | "arrowright" => 124,
        "down" | "arrowdown" => 125,
        "up" | "arrowup" => 126,
        _ => return None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChordKey {
    Code(u16),
    /// A printable ASCII character, resolved against the keyboard layout.
    Char(char),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    pub modifiers: Vec<Modifier>,
    pub key: ChordKey,
}

fn chord_key(part: &str) -> Result<ChordKey, String> {
    let lower = part.to_lowercase();
    if let Some(modifier) = modifier(&lower) {
        return Ok(ChordKey::Code(modifier.key_code()));
    }
    if let Some(code) = named_key_code(&lower) {
        return Ok(ChordKey::Code(code));
    }
    if let Some(number) = lower.strip_prefix('f')
        && let Ok(index) = number.parse::<usize>()
        && (1..=24).contains(&index)
        && !number.starts_with('0')
        && !number.starts_with('+')
    {
        return FUNCTION_KEY_CODES
            .get(index - 1)
            .map(|code| ChordKey::Code(*code))
            .ok_or_else(|| format!("macOS has no {} key; F1 to F20 work", part.to_uppercase()));
    }
    let character = match lower.as_str() {
        "plus" => "+",
        "minus" => "-",
        _ => part,
    };
    let mut characters = character.chars();
    if let (Some(character), None) = (characters.next(), characters.next())
        && ('\x21'..='\x7e').contains(&character)
    {
        return Ok(ChordKey::Char(character.to_ascii_lowercase()));
    }
    Err(format!("Unsupported key name: {part}"))
}

/// A generic combo such as `Cmd+Shift+T` or `ctrl+a`.
pub fn parse_chord(combo: &str) -> Result<Chord, String> {
    let parts: Vec<&str> = combo.split('+').map(str::trim).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(format!("Invalid key combo: {combo}"));
    }
    let (last, held) = parts.split_last().expect("split yields one part");
    let key = chord_key(last)?;
    let held: Vec<String> = held.iter().map(|part| part.to_string()).collect();
    Ok(Chord {
        modifiers: to_modifiers(&held)?,
        key,
    })
}

/// A key code plus the modifiers the layout needs for a character.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyStroke {
    pub code: u16,
    pub modifiers: Vec<Modifier>,
}

/// US ANSI positions of printable ASCII, used when the layout cannot be read
/// and for viewer keys without a physical code.
pub fn ansi_stroke(character: char) -> Option<KeyStroke> {
    let (code, shifted) = match character {
        'a' => (0, false),
        's' => (1, false),
        'd' => (2, false),
        'f' => (3, false),
        'h' => (4, false),
        'g' => (5, false),
        'z' => (6, false),
        'x' => (7, false),
        'c' => (8, false),
        'v' => (9, false),
        'b' => (11, false),
        'q' => (12, false),
        'w' => (13, false),
        'e' => (14, false),
        'r' => (15, false),
        'y' => (16, false),
        't' => (17, false),
        '1' => (18, false),
        '2' => (19, false),
        '3' => (20, false),
        '4' => (21, false),
        '6' => (22, false),
        '5' => (23, false),
        '=' => (24, false),
        '9' => (25, false),
        '7' => (26, false),
        '-' => (27, false),
        '8' => (28, false),
        '0' => (29, false),
        ']' => (30, false),
        'o' => (31, false),
        'u' => (32, false),
        '[' => (33, false),
        'i' => (34, false),
        'p' => (35, false),
        'l' => (37, false),
        'j' => (38, false),
        '\'' => (39, false),
        'k' => (40, false),
        ';' => (41, false),
        '\\' => (42, false),
        ',' => (43, false),
        '/' => (44, false),
        'n' => (45, false),
        'm' => (46, false),
        '.' => (47, false),
        '`' => (50, false),
        '!' => (18, true),
        '@' => (19, true),
        '#' => (20, true),
        '$' => (21, true),
        '^' => (22, true),
        '%' => (23, true),
        '+' => (24, true),
        '(' => (25, true),
        '&' => (26, true),
        '_' => (27, true),
        '*' => (28, true),
        ')' => (29, true),
        '}' => (30, true),
        '{' => (33, true),
        '"' => (39, true),
        ':' => (41, true),
        '|' => (42, true),
        '<' => (43, true),
        '?' => (44, true),
        '>' => (47, true),
        '~' => (50, true),
        _ => return None,
    };
    Some(KeyStroke {
        code,
        modifiers: if shifted {
            vec![Modifier::Shift]
        } else {
            Vec::new()
        },
    })
}

/// What a viewer key press becomes on macOS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKeyAction {
    /// A virtual key code, tracked for modifier flags.
    Code(u16),
    /// A character with no physical key.
    Unicode(u32),
}

// XT (set 1) scan codes, with E0-prefixed codes as `code | 0x80` as noVNC
// sends them, to virtual key codes. A physical code wins over the keysym so
// the desktop's own layout decides what a key types.
fn code_by_xt(code: u32) -> Option<u16> {
    Some(match code {
        1 => 53,
        2 => 18,
        3 => 19,
        4 => 20,
        5 => 21,
        6 => 23,
        7 => 22,
        8 => 26,
        9 => 28,
        10 => 25,
        11 => 29,
        12 => 27,
        13 => 24,
        14 => 51,
        15 => 48,
        16 => 12,
        17 => 13,
        18 => 14,
        19 => 15,
        20 => 17,
        21 => 16,
        22 => 32,
        23 => 34,
        24 => 31,
        25 => 35,
        26 => 33,
        27 => 30,
        28 => 36,
        29 => 59,
        30 => 0,
        31 => 1,
        32 => 2,
        33 => 3,
        34 => 5,
        35 => 4,
        36 => 38,
        37 => 40,
        38 => 37,
        39 => 41,
        40 => 39,
        41 => 50,
        42 => 56,
        43 => 42,
        44 => 6,
        45 => 7,
        46 => 8,
        47 => 9,
        48 => 11,
        49 => 45,
        50 => 46,
        51 => 43,
        52 => 47,
        53 => 44,
        54 => 60,
        55 => 67,
        56 => 58,
        57 => 49,
        58 => 57,
        59 => 122,
        60 => 120,
        61 => 99,
        62 => 118,
        63 => 96,
        64 => 97,
        65 => 98,
        66 => 100,
        67 => 101,
        68 => 109,
        69 => 71,
        71 => 89,
        72 => 91,
        73 => 92,
        74 => 78,
        75 => 86,
        76 => 87,
        77 => 88,
        78 => 69,
        79 => 83,
        80 => 84,
        81 => 85,
        82 => 82,
        83 => 65,
        84 => 105,
        85 => 106,
        86 => 10,
        87 => 103,
        88 => 111,
        89 => 81,
        90 => 90,
        93 => 105,
        94 => 107,
        95 => 113,
        112 => 104,
        113 => 102,
        114 => 104,
        115 => 94,
        125 => 93,
        126 => 95,
        131 => 64,
        132 => 80,
        156 => 76,
        157 => 62,
        160 => 74,
        174 => 73,
        176 => 72,
        181 => 75,
        184 => 61,
        199 => 115,
        200 => 126,
        201 => 116,
        203 => 123,
        205 => 124,
        207 => 119,
        208 => 125,
        209 => 121,
        210 => 114,
        211 => 117,
        219 => 55,
        220 => 54,
        221 => 110,
        245 => 114,
        247 => 79,
        _ => return None,
    })
}

// X keysyms for keys without a printable character.
fn code_by_keysym(keysym: u32) -> Option<u16> {
    Some(match keysym {
        0xff08 => 51,
        0xff09 => 48,
        0xff0d => 36,
        0xff1b => 53,
        0xffff => 117,
        0xff50 => 115,
        0xff51 => 123,
        0xff52 => 126,
        0xff53 => 124,
        0xff54 => 125,
        0xff55 => 116,
        0xff56 => 121,
        0xff57 => 119,
        0xff63 => 114,
        0xff6a => 114,
        0xff8d => 76,
        0xffe1 => 56,
        0xffe2 => 60,
        0xffe3 => 59,
        0xffe4 => 62,
        0xffe5 => 57,
        0xffe7 => 55,
        0xffe8 => 54,
        0xffe9 => 58,
        0xffea => 61,
        0xffeb => 55,
        0xffec => 54,
        0xfe03 => 61,
        0x20 => 49,
        _ => return None,
    })
}

/// The Unicode code point a keysym types, if it is a character.
pub fn keysym_code_point(keysym: u32) -> Option<u32> {
    if (0x20..=0x7e).contains(&keysym) || (0xa0..=0xff).contains(&keysym) {
        return Some(keysym);
    }
    (0x0100_0100..=0x0110_ffff)
        .contains(&keysym)
        .then(|| keysym - 0x0100_0000)
}

pub fn stream_key_action(key: StreamKey) -> Option<StreamKeyAction> {
    if key.keycode != 0
        && let Some(code) = code_by_xt(key.keycode)
    {
        return Some(StreamKeyAction::Code(code));
    }
    if let Some(code) = code_by_keysym(key.keysym) {
        return Some(StreamKeyAction::Code(code));
    }
    if (0xffbe..=0xffd5).contains(&key.keysym) {
        let index = (key.keysym - 0xffbe) as usize;
        return FUNCTION_KEY_CODES
            .get(index)
            .map(|code| StreamKeyAction::Code(*code));
    }
    let code_point = keysym_code_point(key.keysym)?;
    if let Some(character) = char::from_u32(code_point)
        && let Some(stroke) = character
            .to_lowercase()
            .next()
            .filter(|_| character.to_lowercase().count() == 1)
            .and_then(ansi_stroke)
    {
        return Some(StreamKeyAction::Code(stroke.code));
    }
    Some(StreamKeyAction::Unicode(code_point))
}

/// `CGEventFlags` a held key contributes, for both left and right keys.
pub fn stream_modifier_flag(code: u16) -> Option<u64> {
    Some(match code {
        55 | 54 => Modifier::Cmd.flag(),
        56 | 60 => Modifier::Shift.flag(),
        58 | 61 => Modifier::Alt.flag(),
        59 | 62 => Modifier::Ctrl.flag(),
        63 => Modifier::Fn.flag(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(combo: &str) -> Result<Chord, String> {
        parse_chord(combo)
    }

    #[test]
    fn chords_map_names_codes_and_characters() {
        assert_eq!(
            chord("Cmd+Shift+T").unwrap(),
            Chord {
                modifiers: vec![Modifier::Cmd, Modifier::Shift],
                key: ChordKey::Char('t'),
            }
        );
        assert_eq!(
            chord("ctrl+control+a").unwrap().modifiers,
            vec![Modifier::Ctrl]
        );
        assert_eq!(chord("Return").unwrap().key, ChordKey::Code(36));
        assert_eq!(chord("cmd+plus").unwrap().key, ChordKey::Char('+'));
        assert_eq!(chord("alt+minus").unwrap().key, ChordKey::Char('-'));
        assert_eq!(chord("F5").unwrap().key, ChordKey::Code(96));
        assert_eq!(chord("f20").unwrap().key, ChordKey::Code(90));
        assert_eq!(chord("shift").unwrap().key, ChordKey::Code(56));
        assert_eq!(chord("Page_Down").unwrap().key, ChordKey::Code(121));
    }

    #[test]
    fn chords_reject_like_node() {
        assert_eq!(chord("cmd++").unwrap_err(), "Invalid key combo: cmd++");
        assert_eq!(
            chord("F21").unwrap_err(),
            "macOS has no F21 key; F1 to F20 work"
        );
        assert_eq!(chord("hyper+a").unwrap_err(), "Unsupported modifier: hyper");
        assert_eq!(chord("é").unwrap_err(), "Unsupported key name: é");
        assert_eq!(chord("F25").unwrap_err(), "Unsupported key name: F25");
        assert_eq!(chord("F05").unwrap_err(), "Unsupported key name: F05");
    }

    #[test]
    fn ansi_covers_every_printable_ascii_character() {
        for character in '\x21'..='\x7e' {
            assert!(
                ansi_stroke(character.to_ascii_lowercase()).is_some(),
                "{character}"
            );
        }
        assert_eq!(
            ansi_stroke('+'),
            Some(KeyStroke {
                code: 24,
                modifiers: vec![Modifier::Shift]
            })
        );
    }

    fn key(keysym: u32, keycode: u32) -> Option<StreamKeyAction> {
        stream_key_action(StreamKey {
            down: true,
            keysym,
            keycode,
        })
    }

    #[test]
    fn viewer_keys_prefer_the_physical_code() {
        // `y` on a German layout arrives as the Z position's scan code.
        assert_eq!(key(u32::from(b'y'), 44), Some(StreamKeyAction::Code(6)));
        assert_eq!(key(0xffe9, 0), Some(StreamKeyAction::Code(58)));
        assert_eq!(key(0xffc8, 0), Some(StreamKeyAction::Code(103)));
        assert_eq!(key(0xffd1, 0), Some(StreamKeyAction::Code(90)));
        assert_eq!(key(0xffd5, 0), None);
        assert_eq!(key(u32::from(b'A'), 0), Some(StreamKeyAction::Code(0)));
        assert_eq!(key(0xe9, 0), Some(StreamKeyAction::Unicode(0xe9)));
        assert_eq!(key(0x0100_20ac, 0), Some(StreamKeyAction::Unicode(0x20ac)));
        assert_eq!(key(0xfe50, 0), None);
        assert_eq!(key(0xff08, 999), Some(StreamKeyAction::Code(51)));
    }
}

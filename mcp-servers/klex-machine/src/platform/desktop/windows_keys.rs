//! Key names and RFB stream keys as Windows virtual keys and scan codes.
//! Pure mapping, so it is tested on every platform.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::desktop::rfb::StreamKey;

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_RETURN: u16 = 0x0d;
pub const VK_TAB: u16 = 0x09;
/// Tapped while Alt is held so releasing Alt does not open a menu.
pub const VK_UNASSIGNED: u16 = 0xe8;

const VIRTUAL_KEYS: &[(&str, u16)] = &[
    ("alt", 0x12),
    ("option", 0x12),
    ("ctrl", 0x11),
    ("control", 0x11),
    ("shift", 0x10),
    ("super", 0x5b),
    ("meta", 0x5b),
    ("cmd", 0x5b),
    ("command", 0x5b),
    ("win", 0x5b),
    ("windows", 0x5b),
    ("enter", 0x0d),
    ("return", 0x0d),
    ("esc", 0x1b),
    ("escape", 0x1b),
    ("tab", 0x09),
    ("space", 0x20),
    ("backspace", 0x08),
    ("delete", 0x2e),
    ("del", 0x2e),
    ("insert", 0x2d),
    ("home", 0x24),
    ("end", 0x23),
    ("pageup", 0x21),
    ("page_up", 0x21),
    ("pagedown", 0x22),
    ("page_down", 0x22),
    ("up", 0x26),
    ("down", 0x28),
    ("left", 0x25),
    ("right", 0x27),
    ("arrowup", 0x26),
    ("arrowdown", 0x28),
    ("arrowleft", 0x25),
    ("arrowright", 0x27),
    ("capslock", 0x14),
    ("caps_lock", 0x14),
    ("printscreen", 0x2c),
    ("print", 0x2c),
    ("pause", 0x13),
    ("menu", 0x5d),
    ("apps", 0x5d),
    ("numlock", 0x90),
    ("num_lock", 0x90),
];

const MODIFIER_KEYS: [u16; 4] = [VK_SHIFT, VK_CONTROL, VK_MENU, 0x5b];

/// One key of a combo: a virtual key, or a UTF-16 character that the
/// keyboard layout resolves to a key and shift state when it is pressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComboKey {
    Virtual(u16),
    Character(u16),
}

fn named(name: &str) -> Option<u16> {
    VIRTUAL_KEYS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, code)| *code)
}

fn function_number(name: &str) -> Option<u16> {
    let digits = name.strip_prefix('f')?;
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u16>().ok().filter(|n| (1..=24).contains(n))
}

/// A generic combo such as `Ctrl+Shift+T` or `cmd+l`. Letters and digits are
/// virtual keys; other characters go through the keyboard layout.
pub fn parse_combo(combo: &str) -> Result<Vec<ComboKey>, String> {
    let parts: Vec<&str> = combo.split('+').map(str::trim).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(format!("Invalid key combo: {combo}"));
    }
    parts
        .into_iter()
        .map(|part| {
            let lower = part.to_lowercase();
            if let Some(code) = named(&lower) {
                return Ok(ComboKey::Virtual(code));
            }
            if let Some(n) = function_number(&lower) {
                return Ok(ComboKey::Virtual(0x6f + n));
            }
            let character = match lower.as_str() {
                "plus" => "+",
                "minus" => "-",
                _ => part,
            };
            let units: Vec<u16> = character.encode_utf16().collect();
            if let [unit] = units[..] {
                if let Some(ascii) = char::from_u32(unit.into()).filter(char::is_ascii_alphanumeric)
                {
                    return Ok(ComboKey::Virtual(ascii.to_ascii_uppercase() as u16));
                }
                if unit > 0x20 && unit != 0x7f {
                    return Ok(ComboKey::Character(unit));
                }
            }
            Err(format!("Unsupported key name: {part}"))
        })
        .collect()
}

pub fn modifier(name: &str) -> Result<u16, String> {
    named(&name.to_lowercase())
        .filter(|code| MODIFIER_KEYS.contains(code))
        .ok_or_else(|| format!("Unsupported modifier: {name}"))
}

/// Virtual keys SendInput must flag as extended to reach the right key.
pub fn extended(vk: u16) -> bool {
    matches!(
        vk,
        0x21..=0x28 | 0x2c | 0x2d | 0x2e | 0x5b | 0x5c | 0x5d | 0x6f | 0x90 | 0xa3 | 0xa5
    )
}

/// How a viewer's key reaches SendInput. Physical codes win over keysyms so
/// the desktop's own layout decides what a key types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamToken {
    /// A set 1 scan code.
    Scan(u16),
    /// An E0-prefixed set 1 scan code.
    Extended(u16),
    Virtual(u16),
    /// A Unicode code point.
    Character(u32),
}

impl StreamToken {
    /// Ctrl, Alt or Windows: while one is held, characters must be keys to
    /// make shortcuts.
    pub fn is_shortcut_modifier(self) -> bool {
        matches!(
            self,
            Self::Scan(0x1d | 0x38)
                | Self::Extended(0x1d | 0x38 | 0x5b | 0x5c)
                | Self::Virtual(0xa2..=0xa5 | 0x5b | 0x5c)
        )
    }
}

// Windows set 1 scan codes differ from the XT codes noVNC sends for a few keys.
fn windows_by_xt(code: u32) -> Option<StreamToken> {
    use StreamToken::{Extended, Scan, Virtual};
    Some(match code {
        69 => Extended(0x45),
        84 => Extended(0x37),
        93 => Scan(0x64),
        94 => Scan(0x65),
        95 => Scan(0x66),
        85 => Scan(0x67),
        131 => Scan(0x68),
        247 => Scan(0x69),
        132 => Scan(0x6a),
        90 => Scan(0x6b),
        198 => Virtual(0x13),
        _ => return None,
    })
}

fn windows_by_keysym(keysym: u32) -> Option<u16> {
    Some(match keysym {
        65288 => 0x08,
        65289 => 0x09,
        65293 => 0x0d,
        65299 => 0x13,
        65300 => 0x91,
        65307 => 0x1b,
        65535 => 0x2e,
        65360 => 0x24,
        65361 => 0x25,
        65362 => 0x26,
        65363 => 0x27,
        65364 => 0x28,
        65365 => 0x21,
        65366 => 0x22,
        65367 => 0x23,
        65377 => 0x2c,
        65379 => 0x2d,
        65383 => 0x5d,
        65407 => 0x90,
        65421 => 0x0d,
        65505 => 0xa0,
        65506 => 0xa1,
        65507 => 0xa2,
        65508 => 0xa3,
        65509 => 0x14,
        65511 => 0x5b,
        65512 => 0x5c,
        65513 => 0xa4,
        65514 => 0xa5,
        65515 => 0x5b,
        65516 => 0x5c,
        65027 => 0xa5,
        _ => return None,
    })
}

/// The Unicode code point a keysym types, if it is a character.
fn keysym_code_point(keysym: u32) -> Option<u32> {
    match keysym {
        0x20..=0x7e | 0xa0..=0xff => Some(keysym),
        0x0100_0100..=0x0110_ffff => Some(keysym - 0x0100_0000),
        _ => None,
    }
}

pub fn stream_token(key: StreamKey) -> Option<StreamToken> {
    let code = key.keycode;
    if code > 0 && code < 0x100 {
        if let Some(special) = windows_by_xt(code) {
            return Some(special);
        }
        return Some(if code & 0x80 != 0 {
            StreamToken::Extended((code & 0x7f) as u16)
        } else {
            StreamToken::Scan(code as u16)
        });
    }
    if let Some(vk) = windows_by_keysym(key.keysym) {
        return Some(StreamToken::Virtual(vk));
    }
    if (0xffbe..=0xffd5).contains(&key.keysym) {
        return Some(StreamToken::Virtual(0x70 + (key.keysym - 0xffbe) as u16));
    }
    keysym_code_point(key.keysym).map(StreamToken::Character)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(keysym: u32, keycode: u32) -> StreamKey {
        StreamKey {
            down: true,
            keysym,
            keycode,
        }
    }

    #[test]
    fn combos_map_names_letters_and_characters() {
        use ComboKey::{Character, Virtual};
        assert_eq!(
            parse_combo("Ctrl+Shift+t").unwrap(),
            [Virtual(0x11), Virtual(0x10), Virtual(b'T'.into())]
        );
        assert_eq!(
            parse_combo("cmd + F12").unwrap(),
            [Virtual(0x5b), Virtual(0x7b)]
        );
        assert_eq!(
            parse_combo("ctrl+plus").unwrap(),
            [Virtual(0x11), Character(b'+'.into())]
        );
        assert_eq!(parse_combo("ä").unwrap(), [Character(0xe4)]);
        assert_eq!(
            parse_combo("Ctrl++").unwrap_err(),
            "Invalid key combo: Ctrl++"
        );
        assert_eq!(parse_combo("f25").unwrap_err(), "Unsupported key name: f25");
        assert_eq!(parse_combo("f01").unwrap_err(), "Unsupported key name: f01");
        assert_eq!(parse_combo("😀").unwrap_err(), "Unsupported key name: 😀");
    }

    #[test]
    fn modifiers_are_only_modifier_keys() {
        assert_eq!(modifier("Ctrl"), Ok(0x11));
        assert_eq!(modifier("cmd"), Ok(0x5b));
        assert_eq!(
            modifier("enter").unwrap_err(),
            "Unsupported modifier: enter"
        );
    }

    #[test]
    fn stream_keys_prefer_physical_codes() {
        use StreamToken::{Character, Extended, Scan, Virtual};
        assert_eq!(stream_token(key(0x61, 30)), Some(Scan(30)));
        assert_eq!(stream_token(key(65361, 0xcb)), Some(Extended(0x4b)));
        assert_eq!(stream_token(key(0, 69)), Some(Extended(0x45)));
        assert_eq!(stream_token(key(0, 93)), Some(Scan(0x64)));
        assert_eq!(stream_token(key(65361, 0)), Some(Virtual(0x25)));
        assert_eq!(stream_token(key(0xffbe, 0)), Some(Virtual(0x70)));
        assert_eq!(stream_token(key(0xe9, 0)), Some(Character(0xe9)));
        assert_eq!(stream_token(key(0x0100_20ac, 0)), Some(Character(0x20ac)));
        assert_eq!(stream_token(key(0xfe50, 0)), None);
    }

    #[test]
    fn shortcut_modifiers() {
        use StreamToken::{Character, Extended, Scan, Virtual};
        for token in [
            Scan(0x1d),
            Extended(0x1d),
            Scan(0x38),
            Extended(0x38),
            Extended(0x5b),
            Virtual(0xa2),
            Virtual(0x5c),
        ] {
            assert!(token.is_shortcut_modifier(), "{token:?}");
        }
        for token in [Scan(0x2a), Scan(0x5b), Virtual(0xa0), Character(0x61)] {
            assert!(!token.is_shortcut_modifier(), "{token:?}");
        }
    }
}

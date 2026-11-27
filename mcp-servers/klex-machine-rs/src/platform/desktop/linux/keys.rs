//! Key names for X11 input. Combos are first normalized to xdotool's
//! spelling, as the Node server does, then resolved like `XStringToKeysym`.

use std::collections::HashMap;
use std::sync::LazyLock;

const KEY_ALIASES: &[(&str, &str)] = &[
    ("alt", "alt"),
    ("option", "alt"),
    ("ctrl", "ctrl"),
    ("control", "ctrl"),
    ("shift", "shift"),
    ("super", "super"),
    ("meta", "super"),
    ("cmd", "super"),
    ("command", "super"),
    ("win", "super"),
    ("enter", "Return"),
    ("return", "Return"),
    ("esc", "Escape"),
    ("escape", "Escape"),
    ("tab", "Tab"),
    ("space", "space"),
    ("backspace", "BackSpace"),
    ("delete", "Delete"),
    ("del", "Delete"),
    ("insert", "Insert"),
    ("home", "Home"),
    ("end", "End"),
    ("pageup", "Page_Up"),
    ("page_up", "Page_Up"),
    ("pagedown", "Page_Down"),
    ("page_down", "Page_Down"),
    ("up", "Up"),
    ("down", "Down"),
    ("left", "Left"),
    ("right", "Right"),
    ("arrowup", "Up"),
    ("arrowdown", "Down"),
    ("arrowleft", "Left"),
    ("arrowright", "Right"),
    ("plus", "plus"),
    ("minus", "minus"),
];

const MODIFIERS: &[&str] = &["alt", "ctrl", "shift", "super"];

/// xdotool's own names for modifiers, applied before the keysym lookup.
const XDOTOOL_SYMBOLS: &[(&str, &str)] = &[
    ("alt", "Alt_L"),
    ("ctrl", "Control_L"),
    ("control", "Control_L"),
    ("meta", "Meta_L"),
    ("super", "Super_L"),
    ("shift", "Shift_L"),
];

/// Names Xlib accepts that share a keysym with the name `xkeysym` reports.
const KEYSYM_ALIASES: &[(&str, u32)] = &[
    ("Page_Up", 0xff55),
    ("Page_Down", 0xff56),
    ("KP_Page_Up", 0xff9a),
    ("KP_Page_Down", 0xff9b),
    ("script_switch", 0xff7e),
];

/// Keysym ranges that have names: core keysyms and the DEC, HP, Sun and
/// XFree86 vendor blocks.
const NAMED_RANGES: &[(u32, u32)] = &[
    (0x0000_0000, 0x0000_ffff),
    (0x1000_0000, 0x1000_ffff),
    (0x1004_0000, 0x1004_ffff),
    (0x1005_0000, 0x1005_ffff),
    (0x1008_0000, 0x1008_ffff),
];

static KEYSYMS: LazyLock<HashMap<String, u32>> = LazyLock::new(|| {
    let mut names = HashMap::new();
    for &(start, end) in NAMED_RANGES {
        for raw in start..=end {
            if let Some(name) = xkeysym::Keysym::new(raw).name() {
                names.entry(name.replacen("XK_", "", 1)).or_insert(raw);
            }
        }
    }
    for &(name, raw) in KEYSYM_ALIASES {
        names.entry(name.to_string()).or_insert(raw);
    }
    names
});

fn alias(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    KEY_ALIASES
        .iter()
        .find(|(key, _)| *key == lower)
        .map(|(_, value)| *value)
}

fn is_function_key(part: &str) -> bool {
    let Some(number) = part
        .strip_prefix(['f', 'F'])
        .filter(|digits| !digits.starts_with('0'))
        .and_then(|digits| digits.parse::<u32>().ok())
    else {
        return false;
    };
    (1..=24).contains(&number) && part.len() <= 3
}

fn is_keysym_name(part: &str) -> bool {
    (1..=32).contains(&part.len())
        && part
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Maps a generic combo such as `Ctrl+Shift+T` or `cmd+l` to xdotool keysym
/// names, in press order.
pub fn to_xdotool_combo(combo: &str) -> Result<Vec<String>, String> {
    let parts: Vec<&str> = combo.split('+').map(str::trim).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(format!("Invalid key combo: {combo}"));
    }
    parts
        .into_iter()
        .map(|part| {
            if let Some(alias) = alias(part) {
                Ok(alias.to_string())
            } else if is_function_key(part) {
                Ok(part.to_uppercase())
            } else if part.chars().count() == 1 || is_keysym_name(part) {
                Ok(part.to_string())
            } else {
                Err(format!("Unsupported key name: {part}"))
            }
        })
        .collect()
}

pub fn to_xdotool_modifier(modifier: &str) -> Result<String, String> {
    alias(modifier)
        .filter(|mapped| MODIFIERS.contains(mapped))
        .map(str::to_string)
        .ok_or_else(|| format!("Unsupported modifier: {modifier}"))
}

/// The keysym xdotool presses for a name, as `XStringToKeysym` reads it,
/// including `0x` codes and `U+` code points.
pub fn keysym(name: &str) -> Option<u32> {
    let name = XDOTOOL_SYMBOLS
        .iter()
        .find(|(alias, _)| *alias == name)
        .map_or(name, |(_, symbol)| symbol);
    if let Some(&raw) = KEYSYMS.get(name) {
        return Some(raw);
    }
    if let Some(hex) = name.strip_prefix("0x") {
        return u32::from_str_radix(hex, 16).ok().filter(|raw| *raw != 0);
    }
    if let Some(hex) = name.strip_prefix('U').filter(|hex| hex.len() >= 2) {
        let code = u32::from_str_radix(hex, 16).ok()?;
        return match code {
            0..0x20 | 0x7f..0xa0 | 0x11_0000.. => None,
            0..0x100 => Some(code),
            _ => Some(code | 0x0100_0000),
        };
    }
    let mut chars = name.chars();
    match (chars.next(), chars.next()) {
        (Some(character), None) => Some(char_keysym(character)),
        _ => None,
    }
}

/// The keysym that types `character`, as xdotool's `type` picks it.
pub fn char_keysym(character: char) -> u32 {
    match character {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        _ => match xkeysym::Keysym::from_char(character).raw() {
            0 => 0x0100_0000 | character as u32,
            raw => raw,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_generic_combos_to_xdotool_names() {
        assert_eq!(
            to_xdotool_combo("Ctrl+Alt+Delete").unwrap(),
            ["ctrl", "alt", "Delete"]
        );
        assert_eq!(to_xdotool_combo("cmd+L").unwrap(), ["super", "L"]);
        assert_eq!(to_xdotool_combo("Enter").unwrap(), ["Return"]);
        assert_eq!(
            to_xdotool_combo("ctrl+shift+t").unwrap(),
            ["ctrl", "shift", "t"]
        );
        assert_eq!(to_xdotool_combo("f5").unwrap(), ["F5"]);
        assert_eq!(to_xdotool_combo("F24").unwrap(), ["F24"]);
        assert_eq!(to_xdotool_combo("f25").unwrap(), ["f25"]);
        assert_eq!(
            to_xdotool_combo("ctrl+").unwrap_err(),
            "Invalid key combo: ctrl+"
        );
        assert_eq!(
            to_xdotool_combo("ctrl+$(x)").unwrap_err(),
            "Unsupported key name: $(x)"
        );
        assert_eq!(to_xdotool_modifier("Ctrl").unwrap(), "ctrl");
        assert_eq!(to_xdotool_modifier("cmd").unwrap(), "super");
        assert_eq!(
            to_xdotool_modifier("enter").unwrap_err(),
            "Unsupported modifier: enter"
        );
    }

    #[test]
    fn resolves_names_like_xstringtokeysym() {
        assert_eq!(keysym("ctrl"), Some(0xffe3));
        assert_eq!(keysym("super"), Some(0xffeb));
        assert_eq!(keysym("alt"), Some(0xffe9));
        assert_eq!(keysym("shift"), Some(0xffe1));
        assert_eq!(keysym("Return"), Some(0xff0d));
        assert_eq!(keysym("Page_Up"), Some(0xff55));
        assert_eq!(keysym("Prior"), Some(0xff55));
        assert_eq!(keysym("F5"), Some(0xffc2));
        assert_eq!(keysym("a"), Some(0x61));
        assert_eq!(keysym("L"), Some(0x4c));
        assert_eq!(keysym("1"), Some(0x31));
        assert_eq!(keysym("plus"), Some(0x2b));
        assert_eq!(keysym("XF86AudioPlay"), Some(0x1008_ff14));
        assert_eq!(keysym("U20AC"), Some(0x0100_20ac));
        assert_eq!(keysym("U00E9"), Some(0xe9));
        assert_eq!(keysym("0xff0d"), Some(0xff0d));
        assert_eq!(keysym("é"), Some(0xe9));
        assert_eq!(keysym("NoSuchKey"), None);
    }

    #[test]
    fn types_characters_with_their_keysyms() {
        assert_eq!(char_keysym('a'), 0x61);
        assert_eq!(char_keysym('\n'), 0xff0d);
        assert_eq!(char_keysym('\t'), 0xff09);
        assert_eq!(char_keysym('ä'), 0xe4);
        assert_eq!(char_keysym('я'), 0x6d1);
        assert_eq!(char_keysym('😀'), 0x0101_f600);
    }
}

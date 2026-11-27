//! Characters to key codes for the current keyboard layout, so shortcuts
//! such as cmd+z hit the key labelled Z on non-US layouts too. Plain keys win
//! over Shift, Shift over Option (AltGr), so `@` on a German layout is
//! Option+L.

use std::collections::HashMap;
use std::ffi::c_void;

use objc2_core_foundation::{CFData, CFRetained, CFString, CFType};

use super::super::macos_keys::{KeyStroke, Modifier, ansi_stroke};

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut c_void;
    fn TISGetInputSourceProperty(source: *mut c_void, key: &CFString) -> *const c_void;
    static kTISPropertyUnicodeKeyLayoutData: &'static CFString;
    fn LMGetKbdType() -> u8;
    fn UCKeyTranslate(
        layout: *const c_void,
        virtual_key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        key_translate_options: u32,
        dead_key_state: *mut u32,
        max_string_length: usize,
        actual_string_length: *mut usize,
        unicode_string: *mut u16,
    ) -> i32;
}

const KEY_ACTION_DOWN: u16 = 0;
const NO_DEAD_KEYS: u32 = 1;
// Carbon's shiftKey and optionKey, shifted right by 8.
const SHIFT_STATE: u32 = 0x02;
const OPTION_STATE: u32 = 0x08;

#[derive(Default)]
pub struct Layout {
    keys: HashMap<char, KeyStroke>,
}

impl Layout {
    /// Reads the current layout. Must run on the main thread: the Text Input
    /// Sources API asserts it on recent macOS.
    pub fn current() -> Self {
        let mut keys = HashMap::new();
        // SAFETY: a +1 reference, released by CFRetained.
        let source = unsafe { TISCopyCurrentKeyboardLayoutInputSource() };
        let Some(source) = std::ptr::NonNull::new(source.cast::<CFType>()) else {
            return Self { keys };
        };
        // SAFETY: TISCopy… returns an owned reference.
        let source: CFRetained<CFType> = unsafe { CFRetained::from_raw(source) };
        // SAFETY: a borrowed CFData owned by `source`, or null.
        let data = unsafe {
            TISGetInputSourceProperty(
                CFRetained::as_ptr(&source).as_ptr().cast(),
                kTISPropertyUnicodeKeyLayoutData,
            )
        };
        if data.is_null() {
            return Self { keys };
        }
        // SAFETY: the property is a CFData that `source` keeps alive.
        let data = unsafe { &*data.cast::<CFData>() };
        let layout = data.byte_ptr().cast::<c_void>();
        if layout.is_null() {
            return Self { keys };
        }
        // SAFETY: takes no arguments.
        let keyboard_type = u32::from(unsafe { LMGetKbdType() });
        let states = [
            (0, vec![]),
            (SHIFT_STATE, vec![Modifier::Shift]),
            (OPTION_STATE, vec![Modifier::Alt]),
            (
                SHIFT_STATE | OPTION_STATE,
                vec![Modifier::Alt, Modifier::Shift],
            ),
        ];
        for (state, modifiers) in states {
            for code in 0..128u16 {
                let mut dead_key_state = 0u32;
                let mut length = 0usize;
                let mut characters = [0u16; 4];
                // SAFETY: `layout` is a UCKeyboardLayout that outlives the
                // call, and the out pointers are valid for their sizes.
                let status = unsafe {
                    UCKeyTranslate(
                        layout,
                        code,
                        KEY_ACTION_DOWN,
                        state,
                        keyboard_type,
                        NO_DEAD_KEYS,
                        &mut dead_key_state,
                        characters.len(),
                        &mut length,
                        characters.as_mut_ptr(),
                    )
                };
                if status != 0 || length == 0 {
                    continue;
                }
                let text = String::from_utf16_lossy(&characters[..length.min(characters.len())]);
                let mut chars = text.chars();
                if let (Some(character), None) = (chars.next(), chars.next()) {
                    keys.entry(character).or_insert_with(|| KeyStroke {
                        code,
                        modifiers: modifiers.clone(),
                    });
                }
            }
        }
        drop(source);
        Self { keys }
    }

    pub fn stroke(&self, character: char) -> Option<KeyStroke> {
        self.keys
            .get(&character)
            .cloned()
            .or_else(|| ansi_stroke(character))
    }
}

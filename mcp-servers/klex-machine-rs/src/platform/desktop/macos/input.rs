//! Synthetic mouse and keyboard events through Quartz Event Services, in
//! global display points. Blocking: callers run these off the async runtime.

use std::thread::sleep;
use std::time::Duration;

use objc2_core_foundation::{CFRetained, CGPoint};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
    CGEventType, CGMouseButton, CGScrollEventUnit,
};

use super::super::macos_keys::{KeyStroke, Modifier};
use crate::desktop::provider::{MouseButton, ScrollDirection};

pub const RETURN: u16 = 36;
pub const TAB: u16 = 48;

fn pause(milliseconds: u64) {
    sleep(Duration::from_millis(milliseconds));
}

pub struct ButtonEvents {
    pub down: CGEventType,
    pub up: CGEventType,
    pub dragged: CGEventType,
    pub button: CGMouseButton,
}

pub fn button_events(button: MouseButton) -> ButtonEvents {
    match button {
        MouseButton::Left => ButtonEvents {
            down: CGEventType::LeftMouseDown,
            up: CGEventType::LeftMouseUp,
            dragged: CGEventType::LeftMouseDragged,
            button: CGMouseButton::Left,
        },
        MouseButton::Right => ButtonEvents {
            down: CGEventType::RightMouseDown,
            up: CGEventType::RightMouseUp,
            dragged: CGEventType::RightMouseDragged,
            button: CGMouseButton::Right,
        },
        MouseButton::Middle => ButtonEvents {
            down: CGEventType::OtherMouseDown,
            up: CGEventType::OtherMouseUp,
            dragged: CGEventType::OtherMouseDragged,
            button: CGMouseButton::Center,
        },
    }
}

/// Posts events from the HID system state, like a physical device.
pub struct Input {
    source: Option<CFRetained<CGEventSource>>,
}

impl Input {
    pub fn new() -> Self {
        Self {
            source: CGEventSource::new(CGEventSourceStateID::HIDSystemState),
        }
    }

    // A missing event is skipped rather than fatal so held modifiers are
    // still released.
    fn post(event: Option<CFRetained<CGEvent>>) {
        if let Some(event) = event {
            CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        }
    }

    pub fn mouse_event(
        &self,
        kind: CGEventType,
        point: CGPoint,
        button: CGMouseButton,
        flags: u64,
        click_state: Option<i64>,
    ) {
        let event = CGEvent::new_mouse_event(self.source.as_deref(), kind, point, button);
        if let Some(event) = &event {
            CGEvent::set_flags(Some(event), CGEventFlags(flags));
            if let Some(count) = click_state {
                CGEvent::set_integer_value_field(
                    Some(event),
                    CGEventField::MouseEventClickState,
                    count,
                );
            }
        }
        Self::post(event);
    }

    pub fn move_to(&self, point: CGPoint) {
        self.mouse_event(CGEventType::MouseMoved, point, CGMouseButton::Left, 0, None);
    }

    pub fn click(&self, point: CGPoint, button: MouseButton, clicks: u32, modifiers: &[Modifier]) {
        let events = button_events(button);
        self.move_to(point);
        pause(30);
        self.with_modifiers(modifiers, |flags| {
            for index in 1..=clicks {
                for kind in [events.down, events.up] {
                    self.mouse_event(kind, point, events.button, flags, Some(i64::from(index)));
                }
                if index < clicks {
                    pause(60);
                }
            }
        });
    }

    pub fn drag(&self, from: CGPoint, to: CGPoint, button: MouseButton) {
        let events = button_events(button);
        self.move_to(from);
        pause(50);
        self.mouse_event(events.down, from, events.button, 0, None);
        pause(80);
        let steps = 12;
        for step in 1..=steps {
            let progress = f64::from(step) / f64::from(steps);
            let point = CGPoint::new(
                from.x + (to.x - from.x) * progress,
                from.y + (to.y - from.y) * progress,
            );
            self.mouse_event(events.dragged, point, events.button, 0, None);
            pause(15);
        }
        pause(50);
        self.mouse_event(events.up, to, events.button, 0, None);
    }

    pub fn wheel(&self, direction: ScrollDirection, lines: i32, flags: u64) {
        let (vertical, horizontal) = match direction {
            ScrollDirection::Up => (lines, 0),
            ScrollDirection::Down => (-lines, 0),
            ScrollDirection::Left => (0, lines),
            ScrollDirection::Right => (0, -lines),
        };
        let event = CGEvent::new_scroll_wheel_event2(
            self.source.as_deref(),
            CGScrollEventUnit::Line,
            2,
            vertical,
            horizontal,
            0,
        );
        if let Some(event) = &event {
            CGEvent::set_flags(Some(event), CGEventFlags(flags));
        }
        Self::post(event);
    }

    /// One step is three lines, roughly one wheel notch on Linux.
    pub fn scroll(&self, point: CGPoint, direction: ScrollDirection, steps: u32) {
        self.move_to(point);
        pause(30);
        for _ in 0..steps {
            self.wheel(direction, 3, 0);
            pause(20);
        }
    }

    pub fn key_event(&self, code: u16, down: bool, flags: u64) {
        let event = CGEvent::new_keyboard_event(self.source.as_deref(), code, down);
        if let Some(event) = &event {
            CGEvent::set_flags(Some(event), CGEventFlags(flags));
        }
        Self::post(event);
    }

    /// Types one character regardless of the layout.
    pub fn unicode_event(&self, character: char, down: bool, flags: u64) {
        let mut units = [0u16; 2];
        let units = character.encode_utf16(&mut units);
        let event = CGEvent::new_keyboard_event(self.source.as_deref(), 0, down);
        if let Some(event) = &event {
            CGEvent::set_flags(Some(event), CGEventFlags(flags));
            // SAFETY: `units` holds `units.len()` UTF-16 code units.
            unsafe {
                CGEvent::keyboard_set_unicode_string(Some(event), units.len() as _, units.as_ptr());
            }
        }
        Self::post(event);
    }

    fn with_modifiers(&self, modifiers: &[Modifier], body: impl FnOnce(u64)) {
        let mut held = 0;
        for modifier in modifiers {
            held |= modifier.flag();
            self.key_event(modifier.key_code(), true, held);
            pause(10);
        }
        body(held);
        for modifier in modifiers.iter().rev() {
            held &= !modifier.flag();
            self.key_event(modifier.key_code(), false, held);
            pause(10);
        }
    }

    fn tap(&self, code: u16, flags: u64) {
        self.key_event(code, true, flags);
        pause(10);
        self.key_event(code, false, flags);
    }

    pub fn press(&self, modifiers: &[Modifier], stroke: &KeyStroke) {
        let mut all = modifiers.to_vec();
        for modifier in &stroke.modifiers {
            if !all.contains(modifier) {
                all.push(*modifier);
            }
        }
        self.with_modifiers(&all, |flags| self.tap(stroke.code, flags));
    }

    pub fn type_text(&self, text: &str) {
        let mut characters = text.chars().peekable();
        while let Some(character) = characters.next() {
            match character {
                '\r' => {
                    if characters.peek() == Some(&'\n') {
                        characters.next();
                    }
                    self.tap(RETURN, 0);
                }
                '\n' => self.tap(RETURN, 0),
                '\t' => self.tap(TAB, 0),
                _ => {
                    self.unicode_event(character, true, 0);
                    self.unicode_event(character, false, 0);
                }
            }
            pause(8);
        }
    }
}

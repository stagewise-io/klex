//! macOS display geometry and permission hints. Pure, so they are tested on
//! every platform.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use crate::desktop::provider::{Point, Region, ScreenSize};
use crate::desktop::service::js_round;

const SCREEN_RECORDING_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const ACCESSIBILITY_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

pub const NO_SESSION_HINT: &str = "No logged-in macOS desktop session is available to klex-machine. Start it from a Terminal in the logged-in user session, not over SSH or as a system daemon.";

/// The main display: global points, and the pixels of its backing store.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub pixel_width: f64,
    pub pixel_height: f64,
}

impl Display {
    pub fn valid(&self) -> bool {
        [self.width, self.height, self.pixel_width, self.pixel_height]
            .iter()
            .all(|value| value.is_finite() && *value > 0.0)
    }

    pub fn screen(&self) -> ScreenSize {
        ScreenSize {
            width: self.pixel_width as i64,
            height: self.pixel_height as i64,
        }
    }

    /// A pixel as global points, to two decimals.
    pub fn to_points(self, point: Point) -> (f64, f64) {
        let round = |value: f64| js_round(value * 100.0) as f64 / 100.0;
        (
            round(point.x as f64 * self.width / self.pixel_width),
            round(point.y as f64 * self.height / self.pixel_height),
        )
    }

    /// A rectangle in points as pixels.
    pub fn to_pixel_region(self, x: f64, y: f64, width: f64, height: f64) -> Region {
        let scale_x = self.pixel_width / self.width;
        let scale_y = self.pixel_height / self.height;
        Region {
            x: js_round(x * scale_x),
            y: js_round(y * scale_y),
            width: js_round(width * scale_x),
            height: js_round(height * scale_y),
        }
    }
}

/// `Title - App`, or whichever of the two is set.
pub fn window_title(app: &str, title: &str) -> String {
    match (title.is_empty(), app.is_empty()) {
        (false, false) => format!("{title} - {app}"),
        (false, true) => title.to_string(),
        _ => app.to_string(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    ScreenRecording,
    Accessibility,
}

impl Permission {
    fn name(self) -> &'static str {
        match self {
            Self::ScreenRecording => "Screen Recording",
            Self::Accessibility => "Accessibility",
        }
    }
}

fn terminal_app(term_program: &str) -> Option<&'static str> {
    Some(match term_program {
        "Apple_Terminal" => "Terminal",
        "iTerm.app" => "iTerm",
        "WarpTerminal" => "Warp",
        "ghostty" => "Ghostty",
        "vscode" => "your editor (Visual Studio Code or Cursor)",
        _ => return None,
    })
}

/// Which app to grant and where. macOS attributes the permissions to the app
/// that started klex-machine, or to the binary itself when nothing did.
pub fn permission_hint(missing: &[Permission], term_program: &str, binary: &str) -> String {
    let terminal = terminal_app(term_program);
    let app = terminal.map(str::to_string).unwrap_or_else(|| {
        format!(
            "the app that starts klex-machine (your terminal, or {binary} when it runs as a background service)"
        )
    });
    let names: Vec<&str> = missing.iter().map(|permission| permission.name()).collect();
    let panes: Vec<&str> = missing
        .iter()
        .map(|permission| match permission {
            Permission::ScreenRecording => {
                "Screen & System Audio Recording (Screen Recording before macOS 15)"
            }
            Permission::Accessibility => "Accessibility",
        })
        .collect();
    let links: Vec<String> = missing
        .iter()
        .map(|permission| {
            format!(
                "open \"{}\"",
                match permission {
                    Permission::ScreenRecording => SCREEN_RECORDING_SETTINGS,
                    Permission::Accessibility => ACCESSIBILITY_SETTINGS,
                }
            )
        })
        .collect();
    format!(
        "Computer use on macOS needs {} permission. In System Settings > Privacy & Security, turn on {app} under {}, then quit and reopen {} and restart klex-machine. To open the settings, run: {}",
        names.join(" and "),
        panes.join(" and under "),
        terminal.unwrap_or("that app"),
        links.join(" && ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const RETINA: Display = Display {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
        pixel_width: 2880.0,
        pixel_height: 1800.0,
    };

    #[test]
    fn retina_pixels_map_to_points_and_back() {
        assert_eq!(RETINA.to_points(Point { x: 1001, y: 3 }), (500.5, 1.5));
        assert_eq!(
            RETINA.to_pixel_region(10.0, 20.5, 100.0, 50.25),
            Region {
                x: 20,
                y: 41,
                width: 200,
                height: 101
            }
        );
        assert_eq!(
            RETINA.screen(),
            ScreenSize {
                width: 2880,
                height: 1800
            }
        );
        let odd = Display {
            width: 1512.0,
            height: 982.0,
            pixel_width: 3024.0,
            pixel_height: 1964.0,
            ..RETINA
        };
        assert_eq!(odd.to_points(Point { x: 1, y: 1 }), (0.5, 0.5));
        assert!(
            !Display {
                width: 0.0,
                ..RETINA
            }
            .valid()
        );
    }

    #[test]
    fn titles_join_window_and_app() {
        assert_eq!(window_title("Safari", "Start"), "Start - Safari");
        assert_eq!(window_title("", "Start"), "Start");
        assert_eq!(window_title("Finder", ""), "Finder");
    }

    #[test]
    fn hints_name_the_app_to_allow() {
        assert_eq!(
            permission_hint(&[Permission::Accessibility], "iTerm.app", "klex-machine"),
            "Computer use on macOS needs Accessibility permission. In System Settings > Privacy & Security, turn on iTerm under Accessibility, then quit and reopen iTerm and restart klex-machine. To open the settings, run: open \"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility\""
        );
        assert_eq!(
            permission_hint(
                &[Permission::ScreenRecording, Permission::Accessibility],
                "",
                "klex-machine"
            ),
            "Computer use on macOS needs Screen Recording and Accessibility permission. In System Settings > Privacy & Security, turn on the app that starts klex-machine (your terminal, or klex-machine when it runs as a background service) under Screen & System Audio Recording (Screen Recording before macOS 15) and under Accessibility, then quit and reopen that app and restart klex-machine. To open the settings, run: open \"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture\" && open \"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility\""
        );
    }
}

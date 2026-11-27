//! Tray icon and menu. The icon is the app icon with a status dot, drawn at
//! runtime so there is one source image.

use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::desktop::{AppStatus, Desktop, DisplayState};

const TRAY_ID: &str = "main";
const BASE_ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// Menu items whose text follows the status.
pub struct TrayMenu {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
}

fn dot_color(state: DisplayState) -> Option<[u8; 3]> {
    match state {
        DisplayState::Connected => Some([0x22, 0xc5, 0x5e]),
        DisplayState::Connecting => Some([0xf5, 0x9e, 0x0b]),
        DisplayState::Offline => Some([0x9c, 0xa3, 0xaf]),
        DisplayState::Error => Some([0xef, 0x44, 0x44]),
        DisplayState::Stopped => None,
    }
}

/// Draws a filled dot with a light ring in the bottom-right corner of an
/// RGBA image.
pub fn with_dot(rgba: &[u8], width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
    let mut pixels = rgba.to_vec();
    let size = width.min(height) as f32;
    let radius = size * 0.26;
    let ring = (size * 0.06).max(1.0);
    let (center_x, center_y) = (width as f32 - radius - 0.5, height as f32 - radius - 0.5);
    for y in 0..height {
        for x in 0..width {
            let distance = ((x as f32 - center_x).powi(2) + (y as f32 - center_y).powi(2)).sqrt();
            let rgb = if distance <= radius - ring {
                color
            } else if distance <= radius {
                [0xff, 0xff, 0xff]
            } else {
                continue;
            };
            let index = ((y * width + x) * 4) as usize;
            pixels[index..index + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 0xff]);
        }
    }
    pixels
}

fn icon(state: DisplayState) -> Image<'static> {
    let base = Image::from_bytes(BASE_ICON).expect("bundled tray icon is a valid PNG");
    let (width, height) = (base.width(), base.height());
    let rgba = match dot_color(state) {
        Some(color) => with_dot(base.rgba(), width, height, color),
        None => base.rgba().to_vec(),
    };
    Image::new_owned(rgba, width, height)
}

fn status_text(status: &AppStatus) -> String {
    if !status.paired {
        return "Not connected to Klex Cloud".into();
    }
    let organization = status.organization_name.as_deref().unwrap_or("Klex Cloud");
    match status.state {
        DisplayState::Connected => format!("Connected to {organization}"),
        DisplayState::Connecting => format!("Connecting to {organization}…"),
        DisplayState::Offline => "Offline, reconnecting…".into(),
        DisplayState::Error => "Needs attention".into(),
        DisplayState::Stopped => "Disconnected".into(),
    }
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(crate::WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn create(app: &AppHandle, status: &AppStatus) -> tauri::Result<()> {
    let status_item = MenuItem::with_id(app, "status", status_text(status), false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Klex Desktop", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Disconnect", status.paired, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(status.state))
        .tooltip(app.package_info().name.clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "toggle" => {
                let desktop = app.state::<Arc<Desktop>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let enabled = !desktop.status().enabled;
                    let _ = crate::set_enabled_inner(&desktop, enabled).await;
                });
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<Arc<Desktop>>().stop().await;
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(TrayMenu {
        status: status_item,
        toggle,
    });
    update(app, status);
    Ok(())
}

pub fn update(app: &AppHandle, status: &AppStatus) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(icon(status.state)));
        let _ = tray.set_tooltip(Some(format!(
            "{}: {}",
            app.package_info().name,
            status_text(status)
        )));
    }
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu.status.set_text(status_text(status));
        let _ = menu.toggle.set_text(if status.enabled {
            "Disconnect"
        } else {
            "Connect"
        });
        let _ = menu.toggle.set_enabled(status.paired);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_the_dot_in_the_corner_only() {
        let (width, height) = (32, 32);
        let base = vec![0u8; (width * height * 4) as usize];
        let pixels = with_dot(&base, width, height, [1, 2, 3]);
        let pixel = |x: u32, y: u32| {
            let index = ((y * width + x) * 4) as usize;
            &pixels[index..index + 4]
        };
        assert_eq!(pixel(0, 0), &[0, 0, 0, 0]);
        assert_eq!(pixel(width - 9, height - 9), &[1, 2, 3, 0xff]);
        assert_eq!(pixel(width - 1, height - 9), &[0xff, 0xff, 0xff, 0xff]);
    }

    #[test]
    fn bundles_a_decodable_icon() {
        for state in [DisplayState::Connected, DisplayState::Stopped] {
            let image = icon(state);
            assert_eq!(
                image.rgba().len(),
                (image.width() * image.height() * 4) as usize
            );
        }
    }

    #[test]
    fn describes_states() {
        let status = AppStatus {
            paired: true,
            enabled: true,
            state: DisplayState::Connected,
            machine_id: Some("m1".into()),
            organization_name: Some("Kanzlei Müller".into()),
            reason: None,
            autostart: true,
        };
        assert_eq!(status_text(&status), "Connected to Kanzlei Müller");
        let unpaired = AppStatus {
            paired: false,
            ..status
        };
        assert_eq!(status_text(&unpaired), "Not connected to Klex Cloud");
    }
}

//! macOS desktop: ScreenCaptureKit for screenshots and the stream, Quartz
//! events for input, the window server and Accessibility API for windows,
//! and Launch Services for apps, all in process. Computer use needs a
//! logged-in window server session plus Screen Recording and Accessibility
//! permission for the app that started klex-machine. There is no
//! accessibility tree yet.
//!
//! The provider works in physical pixels; Quartz takes points, so
//! coordinates are scaled by the backing scale factor (2 on Retina).

mod capture;
mod input;
mod launch;
mod layout;
mod stream;
mod system;
#[cfg(test)]
mod tests;
pub mod threads;
mod windows;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::future::BoxFuture;
use objc2_core_foundation::CGPoint;
use tokio::io::DuplexStream;
use unicode_segmentation::UnicodeSegmentation;

use super::macos_display::{Display, NO_SESSION_HINT, Permission, permission_hint, window_title};
use super::macos_keys::{ChordKey, KeyStroke, parse_chord, to_modifiers};
use crate::desktop::Warn;
use crate::desktop::image::RgbImage;
use crate::desktop::provider::{
    CaptureOptions, DesktopCapabilities, DesktopFuture, DesktopProvider, DesktopWindow,
    LaunchOptions, MouseButton, Point, Region, ScreenSize, ScrollDirection,
};
use crate::desktop::rfb::RfbServer;
use input::Input;
use layout::Layout;
use threads::{blocking, on_main};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
/// Longer than Launch Services' own wait, so a slow cold start reports its
/// error instead of a timeout.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_WINDOWS: usize = 50;
const TYPE_CHUNK_CHARACTERS: usize = 200;
/// Input re-reads the scale only when the last read is older than this; the
/// service reads the screen size before every action anyway.
const DISPLAY_TTL: Duration = Duration::from_secs(2);

pub fn provider(warn: Warn) -> Arc<dyn DesktopProvider> {
    Arc::new(MacosDesktopProvider {
        warn,
        display: Mutex::new(None),
        last_hint: Mutex::new(None),
        stream: OnceLock::new(),
    })
}

struct MacosDesktopProvider {
    warn: Warn,
    display: Mutex<Option<(Display, Instant)>>,
    last_hint: Mutex<Option<String>>,
    stream: OnceLock<RfbServer>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unavailable(hint: String) -> DesktopCapabilities {
    DesktopCapabilities::unavailable(hint)
}

fn check_count(count: u32) -> Result<(), String> {
    if (1..=100).contains(&count) {
        Ok(())
    } else {
        Err(format!("Invalid count: {count}"))
    }
}

fn point(display: &Display, point: Point) -> CGPoint {
    let (x, y) = display.to_points(point);
    CGPoint::new(x, y)
}

impl MacosDesktopProvider {
    async fn check(&self) -> Result<DesktopCapabilities, String> {
        let probe = blocking("The macOS desktop probe", COMMAND_TIMEOUT, || {
            Ok(system::probe())
        })
        .await?;
        if !probe.session {
            return Ok(unavailable(NO_SESSION_HINT.into()));
        }
        let mut missing = Vec::new();
        if !probe.screen_recording {
            missing.push(Permission::ScreenRecording);
        }
        if !probe.accessibility {
            missing.push(Permission::Accessibility);
        }
        if !missing.is_empty() {
            let term_program = std::env::var("TERM_PROGRAM").unwrap_or_default();
            return Ok(unavailable(permission_hint(
                &missing,
                &term_program,
                crate::BIN_NAME,
            )));
        }
        let display = probe
            .display
            .filter(Display::valid)
            .ok_or_else(|| "Unexpected display geometry".to_string())?;
        *lock(&self.display) = Some((display, Instant::now()));
        Ok(DesktopCapabilities {
            computer_use: true,
            stream: true,
            screen: Some(display.screen()),
            ..DesktopCapabilities::default()
        })
    }

    async fn probe_now(&self) -> DesktopCapabilities {
        let capabilities = self.check().await.unwrap_or_else(|error| {
            unavailable(format!("The macOS desktop probe failed: {error}"))
        });
        let mut last = lock(&self.last_hint);
        if let Some(hint) = &capabilities.hint
            && last.as_ref() != Some(hint)
        {
            (self.warn)(hint);
        }
        *last = capabilities.hint.clone();
        capabilities
    }

    async fn read_display(&self) -> Result<Display, String> {
        let display =
            blocking("Reading the display", COMMAND_TIMEOUT, system::read_display).await?;
        *lock(&self.display) = Some((display, Instant::now()));
        Ok(display)
    }

    async fn current_display(&self) -> Result<Display, String> {
        if let Some((display, at)) = *lock(&self.display)
            && at.elapsed() < DISPLAY_TTL
        {
            return Ok(display);
        }
        self.read_display().await
    }

    /// Runs input after checking Accessibility, which macOS would otherwise
    /// let drop events silently.
    async fn input(
        &self,
        what: &str,
        work: impl FnOnce(&Input) + Send + 'static,
    ) -> Result<(), String> {
        blocking(what, COMMAND_TIMEOUT, move || {
            system::require_accessibility()?;
            work(&Input::new());
            Ok(())
        })
        .await
    }

    async fn capture_now(&self, options: CaptureOptions) -> Result<Vec<u8>, String> {
        let display = self.current_display().await?;
        let screen = display.screen();
        // ScreenCaptureKit letterboxes other aspect ratios, so only a
        // proportional full-screen size is captured directly.
        let output = match (options.region, options.size) {
            (None, Some(size)) if same_aspect(size, screen) => size,
            _ => screen,
        };
        let (width, height) = (output.width.max(1) as usize, output.height.max(1) as usize);
        let (frame_width, frame_height, bgra) =
            blocking("Screen capture", COMMAND_TIMEOUT, move || {
                if !system::screen_recording_allowed() {
                    return Err(system::SCREEN_RECORDING_MISSING.into());
                }
                capture::screenshot(width, height, COMMAND_TIMEOUT)
            })
            .await?;
        let image = match options.region {
            None => RgbImage::from_bgrx(
                frame_width as u32,
                frame_height as u32,
                frame_width * 4,
                &bgra,
            ),
            Some(region) => crop(&bgra, frame_width, frame_height, screen, region),
        };
        let size = options.size.unwrap_or(match options.region {
            Some(region) => ScreenSize {
                width: region.width,
                height: region.height,
            },
            None => screen,
        });
        let data = image.resized(size).encode(options.format)?;
        if data.is_empty() {
            return Err("Screen capture returned no data".into());
        }
        Ok(data)
    }
}

fn same_aspect(size: ScreenSize, screen: ScreenSize) -> bool {
    let (width, height) = (size.width.max(1) as f64, size.height.max(1) as f64);
    let expected = height * screen.width.max(1) as f64 / screen.height.max(1) as f64;
    (width - expected).abs() <= 1.0
}

/// A physical-pixel region of a frame that may differ in size from the
/// screen.
fn crop(bgra: &[u8], width: usize, height: usize, screen: ScreenSize, region: Region) -> RgbImage {
    let scale_x = width as f64 / screen.width.max(1) as f64;
    let scale_y = height as f64 / screen.height.max(1) as f64;
    let x = ((region.x as f64 * scale_x).floor() as usize).min(width - 1);
    let y = ((region.y as f64 * scale_y).floor() as usize).min(height - 1);
    let w = ((region.width as f64 * scale_x).ceil() as usize).clamp(1, width - x);
    let h = ((region.height as f64 * scale_y).ceil() as usize).clamp(1, height - y);
    let stride = width * 4;
    RgbImage::from_bgrx(w as u32, h as u32, stride, &bgra[y * stride + x * 4..])
}

fn ready<'a, T: Send + 'a>(result: Result<T, String>) -> DesktopFuture<'a, T> {
    futures::future::ready(result).boxed()
}

impl DesktopProvider for MacosDesktopProvider {
    fn probe(&self) -> BoxFuture<'_, DesktopCapabilities> {
        self.probe_now().boxed()
    }

    fn screen_size(&self) -> DesktopFuture<'_, ScreenSize> {
        async move { Ok(self.read_display().await?.screen()) }.boxed()
    }

    fn capture(&self, options: CaptureOptions) -> DesktopFuture<'_, Vec<u8>> {
        self.capture_now(options).boxed()
    }

    fn click(
        &self,
        at: Point,
        button: MouseButton,
        count: u32,
        modifiers: Vec<String>,
    ) -> DesktopFuture<'_, ()> {
        async move {
            check_count(count)?;
            let held = to_modifiers(&modifiers)?;
            let target = point(&self.current_display().await?, at);
            self.input("Click", move |input| {
                input.click(target, button, count, &held)
            })
            .await
        }
        .boxed()
    }

    fn drag(&self, from: Point, to: Point, button: MouseButton) -> DesktopFuture<'_, ()> {
        async move {
            let display = self.current_display().await?;
            let (from, to) = (point(&display, from), point(&display, to));
            self.input("Drag", move |input| input.drag(from, to, button))
                .await
        }
        .boxed()
    }

    fn move_to(&self, at: Point) -> DesktopFuture<'_, ()> {
        async move {
            let target = point(&self.current_display().await?, at);
            self.input("Move", move |input| input.move_to(target)).await
        }
        .boxed()
    }

    fn scroll(&self, at: Point, direction: ScrollDirection, amount: u32) -> DesktopFuture<'_, ()> {
        async move {
            check_count(amount)?;
            let target = point(&self.current_display().await?, at);
            self.input("Scroll", move |input| {
                input.scroll(target, direction, amount)
            })
            .await
        }
        .boxed()
    }

    fn type_text(&self, text: String) -> DesktopFuture<'_, ()> {
        async move {
            // Whole grapheme clusters, so CRLF pairs and emoji sequences
            // never straddle a chunk boundary.
            let clusters: Vec<&str> = text.graphemes(true).collect();
            for chunk in clusters.chunks(TYPE_CHUNK_CHARACTERS) {
                let chunk: String = chunk.concat();
                self.input("Typing", move |input| input.type_text(&chunk))
                    .await?;
            }
            Ok(())
        }
        .boxed()
    }

    fn key(&self, combos: Vec<String>) -> DesktopFuture<'_, ()> {
        async move {
            let chords = combos
                .iter()
                .map(|combo| parse_chord(combo))
                .collect::<Result<Vec<_>, _>>()?;
            if chords.is_empty() {
                return Err("key takes at least one chord".into());
            }
            let needs_layout = chords
                .iter()
                .any(|chord| matches!(chord.key, ChordKey::Char(_)));
            let layout = if needs_layout && threads::main_thread_hosted() {
                on_main("Reading the keyboard layout", COMMAND_TIMEOUT, || {
                    Ok(Layout::current())
                })
                .await?
            } else {
                Layout::default()
            };
            let mut strokes = Vec::new();
            for chord in chords {
                let stroke = match chord.key {
                    ChordKey::Code(code) => KeyStroke {
                        code,
                        modifiers: Vec::new(),
                    },
                    ChordKey::Char(character) => layout
                        .stroke(character)
                        .ok_or_else(|| format!("Unsupported key: char:{character}"))?,
                };
                strokes.push((chord.modifiers, stroke));
            }
            self.input("Key press", move |input| {
                for (index, (modifiers, stroke)) in strokes.iter().enumerate() {
                    if index > 0 {
                        std::thread::sleep(Duration::from_millis(40));
                    }
                    input.press(modifiers, stroke);
                }
            })
            .await
        }
        .boxed()
    }

    fn list_windows(&self) -> DesktopFuture<'_, Vec<DesktopWindow>> {
        async move {
            let display = self.current_display().await?;
            let listed =
                blocking("Listing windows", COMMAND_TIMEOUT, || Ok(windows::list())).await?;
            let mut out = Vec::new();
            for window in listed {
                if out.len() >= MAX_WINDOWS {
                    break;
                }
                let bounds = display.to_pixel_region(
                    window.bounds.origin.x,
                    window.bounds.origin.y,
                    window.bounds.size.width,
                    window.bounds.size.height,
                );
                if bounds.width <= 1 || bounds.height <= 1 {
                    continue;
                }
                out.push(DesktopWindow {
                    id: window.id,
                    title: window_title(&window.app, &window.title),
                    bounds,
                    focused: window.focused,
                });
            }
            Ok(out)
        }
        .boxed()
    }

    fn focus_window(&self, id: String) -> DesktopFuture<'_, ()> {
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
            return ready(Err(format!("Invalid window id: {id}")));
        }
        blocking("Focusing the window", COMMAND_TIMEOUT, move || {
            system::require_accessibility()?;
            windows::focus(&id)
        })
        .boxed()
    }

    /// App bundles such as `Safari.app` or `/Applications/Safari.app` open
    /// through Launch Services; anything else is spawned as a process.
    fn launch(&self, options: LaunchOptions) -> DesktopFuture<'_, u32> {
        if !launch::is_bundle(&options.command) {
            return ready(launch::spawn(&options));
        }
        let target = options
            .command
            .strip_suffix('/')
            .unwrap_or(&options.command)
            .to_string();
        // Launch Services takes calls from any thread; waiting on the main
        // thread would stall AppKit work such as the stream clipboard.
        blocking("Opening the app", LAUNCH_TIMEOUT, move || {
            launch::open_application(&target, &options.args)
        })
        .boxed()
    }

    fn open_stream(&self) -> DesktopFuture<'_, DuplexStream> {
        async move {
            let capabilities = self.probe_now().await;
            if !capabilities.stream {
                return Err(capabilities
                    .hint
                    .unwrap_or_else(|| "The macOS desktop cannot stream".into()));
            }
            let warn = self.warn.clone();
            let server = self.stream.get_or_init(|| {
                RfbServer::new(
                    Arc::new(stream::MacosStreamBackend),
                    crate::platform::host::hostname(),
                )
                .on_error(Arc::new(move |error: &str| warn(error)))
            });
            Ok(server.open())
        }
        .boxed()
    }
}

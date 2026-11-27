//! The built-in stream for an X display without a VNC server: `GetImage`
//! frames through the tile sender, and viewer input through XTEST. Each runs
//! on its own thread with its own connection.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::sleep;
use std::time::{Duration, Instant};

use x11rb::protocol::xproto::Keycode;

use super::x11::{self, Session, XError};
use crate::desktop::Warn;
use crate::desktop::provider::{MouseButton, ScrollDirection};
use crate::desktop::rfb::tiles::{FrameRef, TileSender};
use crate::desktop::rfb::{StreamBackend, StreamCapture, StreamKey, StreamSink};

const FRAME: Duration = Duration::from_millis(100);
/// Consecutive failed grabs before the stream gives up.
const MAX_FAILURES: u32 = 20;

pub struct X11StreamBackend {
    display: String,
    warn: Warn,
}

impl X11StreamBackend {
    pub fn new(display: String, warn: Warn) -> Self {
        Self { display, warn }
    }
}

struct Shared {
    running: AtomicBool,
    quality: AtomicU8,
    refresh: AtomicBool,
}

enum Input {
    Move(u32, u32),
    Button(MouseButton, bool, u32, u32),
    Wheel(ScrollDirection, u32, u32),
    Key(StreamKey),
}

impl StreamBackend for X11StreamBackend {
    fn start(&self, sink: StreamSink) -> Result<Box<dyn StreamCapture>, String> {
        let shared = Arc::new(Shared {
            running: AtomicBool::new(true),
            quality: AtomicU8::new(0),
            refresh: AtomicBool::new(false),
        });
        let (input, inputs) = channel();
        let capture = (shared.clone(), self.display.clone(), self.warn.clone());
        std::thread::Builder::new()
            .name("x11-capture".into())
            .spawn(move || {
                let (shared, display, warn) = capture;
                let error = capture_loop(&shared, &display, &sink, &warn).err();
                shared.running.store(false, Ordering::SeqCst);
                sink.ended(error);
            })
            .map_err(|error| format!("Could not start the stream capture: {error}"))?;
        let input_state = (self.display.clone(), self.warn.clone());
        let started = std::thread::Builder::new()
            .name("x11-input".into())
            .spawn(move || input_loop(&input_state.0, &input_state.1, &inputs));
        if let Err(error) = started {
            shared.running.store(false, Ordering::SeqCst);
            return Err(format!("Could not start the stream input: {error}"));
        }
        Ok(Box::new(X11Capture {
            shared,
            input: Some(input),
        }))
    }
}

struct X11Capture {
    shared: Arc<Shared>,
    input: Option<Sender<Input>>,
}

impl X11Capture {
    fn send(&self, input: Input) {
        if let Some(sender) = &self.input {
            let _ = sender.send(input);
        }
    }
}

impl StreamCapture for X11Capture {
    fn set_quality(&mut self, quality: Option<u8>) {
        self.shared
            .quality
            .store(quality.unwrap_or(0).min(100), Ordering::SeqCst);
    }

    fn refresh(&mut self) {
        self.shared.refresh.store(true, Ordering::SeqCst);
    }

    fn move_to(&mut self, x: u32, y: u32) {
        self.send(Input::Move(x, y));
    }

    fn button(&mut self, button: MouseButton, down: bool, x: u32, y: u32) {
        self.send(Input::Button(button, down, x, y));
    }

    fn wheel(&mut self, direction: ScrollDirection, x: u32, y: u32) {
        self.send(Input::Wheel(direction, x, y));
    }

    fn key(&mut self, key: StreamKey) {
        self.send(Input::Key(key));
    }

    // X selections need an owner window answering requests; not supported yet.
    fn set_clipboard(&mut self, _text: String) {}

    fn stop(&mut self) {
        self.shared.running.store(false, Ordering::SeqCst);
        // The input thread lets go of held keys and buttons once its channel closes.
        self.input = None;
    }
}

impl Drop for X11Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn message(error: XError) -> String {
    match error {
        XError::Broken(message) | XError::Failed(message) => message,
    }
}

fn capture_loop(
    shared: &Shared,
    display: &str,
    sink: &StreamSink,
    warn: &Warn,
) -> Result<(), String> {
    let mut session = Session::open(display)?;
    let mut tiles = TileSender::new();
    let mut failures = 0;
    while shared.running.load(Ordering::SeqCst) {
        let started = Instant::now();
        match session.grab() {
            Ok((width, height, bgrx)) => {
                failures = 0;
                let full = shared.refresh.swap(false, Ordering::SeqCst);
                let quality = shared.quality.load(Ordering::SeqCst);
                let frame = FrameRef {
                    width,
                    height,
                    bgrx: &bgrx,
                };
                if !tiles.send(sink, frame, quality, full, true)? {
                    return Ok(());
                }
            }
            Err(error) => {
                failures += 1;
                let broken = matches!(error, XError::Broken(_));
                let error = message(error);
                if failures >= MAX_FAILURES {
                    return Err(format!("The X display stopped answering: {error}"));
                }
                if failures == 1 {
                    warn(&format!("Screen capture failed: {error}"));
                }
                if broken {
                    sleep(Duration::from_millis(500));
                    if let Ok(reopened) = Session::open(display) {
                        session = reopened;
                    }
                }
            }
        }
        sleep(
            FRAME
                .saturating_sub(started.elapsed())
                .max(Duration::from_millis(10)),
        );
    }
    Ok(())
}

#[derive(Default)]
struct Held {
    buttons: Vec<MouseButton>,
    keys: Vec<Keycode>,
}

fn input_loop(display: &str, warn: &Warn, inputs: &Receiver<Input>) {
    let session = match Session::open(display) {
        Ok(session) => session,
        Err(error) => {
            warn(&format!("Stream input is unavailable: {error}"));
            return;
        }
    };
    let mut held = Held::default();
    for input in inputs {
        if let Err(error) = apply(&session, &mut held, input) {
            warn(&format!("Stream input failed: {}", message(error)));
        }
    }
    for button in held.buttons {
        let _ = session.mouse_button(button, false);
    }
    for code in held.keys.into_iter().rev() {
        let _ = session.press(code, false);
    }
}

fn apply(session: &Session, held: &mut Held, input: Input) -> x11::XResult<()> {
    match input {
        Input::Move(x, y) => session.move_to(x.into(), y.into()),
        Input::Button(button, down, x, y) => {
            session.move_to(x.into(), y.into())?;
            held.buttons.retain(|&held| held != button);
            if down {
                held.buttons.push(button);
            }
            session.mouse_button(button, down)
        }
        Input::Wheel(direction, x, y) => {
            session.move_to(x.into(), y.into())?;
            session.click(x11::scroll_button(direction), 1, Duration::ZERO)
        }
        Input::Key(key) => {
            let Some(code) = session.keycode_for(key.keysym)? else {
                return Ok(());
            };
            held.keys.retain(|&held| held != code);
            if key.down {
                held.keys.push(code);
            }
            session.press(code, key.down)
        }
    }
}

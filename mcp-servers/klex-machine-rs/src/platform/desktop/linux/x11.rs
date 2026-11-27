//! One X11 display: capture through `GetImage`, input through XTest and
//! windows through EWMH, matching what xdotool and ImageMagick do for the
//! Node server. Calls block, so they run on the blocking pool under a
//! timeout; a call that times out shuts the socket down to release its
//! thread, and the next call reconnects.

use std::os::fd::{AsRawFd, RawFd};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};

use x11rb::CURRENT_TIME;
use x11rb::connection::{Connection, RequestConnection};
use x11rb::errors::{ConnectError, ConnectionError, ReplyError};
use x11rb::image::{BitsPerPixel, Image, ImageOrder, PixelLayout};
use x11rb::protocol::xproto::{
    Atom, AtomEnum, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ClientMessageEvent,
    ConnectionExt as _, EventMask, InputFocus, KEY_PRESS_EVENT, KEY_RELEASE_EVENT, Keycode,
    MOTION_NOTIFY_EVENT, MapState, Window,
};
use x11rb::protocol::xtest::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use super::keys;
use crate::desktop::image::RgbImage;
use crate::desktop::provider::{
    CaptureOptions, DesktopWindow, MouseButton, Region, ScreenSize, ScrollDirection,
};

pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CLICK_HOLD: Duration = Duration::from_millis(12);
const FOCUS_WAIT: Duration = Duration::from_secs(2);
const FOCUS_POLL: Duration = Duration::from_millis(30);
const MAX_WINDOWS: usize = 50;
const SHIFT_L: u32 = 0xffe1;
const CAPS_LOCK: u32 = 0xffe5;
const LOCK_MASK: u16 = 1 << 1;

pub enum XError {
    /// The connection is unusable; the session is dropped.
    Broken(String),
    /// The request failed; the connection is fine.
    Failed(String),
}

pub type XResult<T> = Result<T, XError>;

impl From<ConnectionError> for XError {
    fn from(error: ConnectionError) -> Self {
        Self::Broken(format!("X connection failed: {error}"))
    }
}

impl From<ReplyError> for XError {
    fn from(error: ReplyError) -> Self {
        match error {
            ReplyError::ConnectionError(error) => error.into(),
            ReplyError::X11Error(error) => {
                Self::Failed(format!("X request failed: {:?}", error.error_kind))
            }
        }
    }
}

impl From<String> for XError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for XError {
    fn from(message: &str) -> Self {
        Self::Failed(message.to_string())
    }
}

struct Atoms {
    net_active_window: Atom,
    net_wm_name: Atom,
    net_wm_pid: Atom,
    net_supported: Atom,
    net_wm_desktop: Atom,
    net_current_desktop: Atom,
    utf8_string: Atom,
    at_spi_bus: Atom,
}

pub struct Session {
    conn: RustConnection,
    fd: RawFd,
    root: Window,
    roots: Vec<Window>,
    atoms: Atoms,
    xtest: bool,
    bindings: Bindings,
}

/// Spare keycodes bound to a keysym and not yet unbound. It outlives each
/// session so the next one can unbind what a timed-out call left behind.
type Bindings = Arc<Mutex<Vec<(Keycode, u32)>>>;

/// The display named by `DISPLAY`, connected on first use.
pub struct Display {
    name: String,
    session: tokio::sync::Mutex<Option<Arc<Session>>>,
    bindings: Bindings,
}

impl Display {
    pub fn new(name: String) -> Self {
        Self {
            name,
            session: tokio::sync::Mutex::new(None),
            bindings: Bindings::default(),
        }
    }

    async fn session(&self) -> Result<Arc<Session>, String> {
        let mut current = self.session.lock().await;
        if let Some(session) = current.as_ref() {
            return Ok(session.clone());
        }
        let name = self.name.clone();
        let bindings = self.bindings.clone();
        let connect = tokio::task::spawn_blocking(move || Session::connect(&name, bindings));
        let session = match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
            Ok(Ok(result)) => Arc::new(result?),
            Ok(Err(_)) => return Err(format!("Can't open display: {}", self.name)),
            Err(_) => {
                return Err(format!("Can't open display: {}: timed out", self.name));
            }
        };
        *current = Some(session.clone());
        Ok(session)
    }

    async fn reset(&self, session: &Arc<Session>) {
        let mut current = self.session.lock().await;
        if current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            current.take();
        }
        // SAFETY: `session` owns the connection, so the descriptor is open.
        unsafe { libc::shutdown(session.fd, libc::SHUT_RDWR) };
    }

    /// Runs `op` against the display, bounded by `timeout`.
    pub async fn run<T, F>(&self, timeout: Duration, op: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&Session) -> XResult<T> + Send + 'static,
    {
        let session = self.session().await?;
        let worker = session.clone();
        let task = tokio::task::spawn_blocking(move || op(&worker));
        match tokio::time::timeout(timeout, task).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(XError::Failed(message)))) => Err(message),
            Ok(Ok(Err(XError::Broken(message)))) => {
                self.reset(&session).await;
                Err(message)
            }
            Ok(Err(_)) => Err("X11 call failed".into()),
            Err(_) => {
                self.reset(&session).await;
                Err("X11 call timed out".into())
            }
        }
    }
}

/// The keyboard mapping, as `GetKeyboardMapping` returns it.
struct Keymap {
    min: Keycode,
    per: usize,
    syms: Vec<u32>,
}

impl Keymap {
    fn keysyms(&self, keycode: Keycode) -> &[u32] {
        let start = (keycode - self.min) as usize * self.per;
        &self.syms[start..start + self.per]
    }

    fn keycodes(&self) -> impl DoubleEndedIterator<Item = Keycode> + '_ {
        (0..self.syms.len() / self.per.max(1)).map(|index| self.min + index as Keycode)
    }

    /// The keycode and shift level that produce `keysym` without remapping.
    fn find(&self, keysym: u32) -> Option<(Keycode, bool)> {
        for column in 0..self.per.min(2) {
            if let Some(keycode) = self
                .keycodes()
                .find(|&keycode| self.keysyms(keycode)[column] == keysym)
            {
                return Some((keycode, column == 1));
            }
        }
        None
    }

    fn spare(&self, taken: &[Keycode]) -> Option<Keycode> {
        self.keycodes().rev().find(|&keycode| {
            !taken.contains(&keycode) && self.keysyms(keycode).iter().all(|sym| *sym == 0)
        })
    }
}

/// A key to press: its keycode, whether it needs Shift, and whether it was
/// bound to a spare keycode that must be unbound afterwards.
#[derive(Clone, Copy)]
struct Key {
    code: Keycode,
    shift: bool,
    bound: bool,
}

fn clamp16(value: i64) -> i16 {
    value.clamp(i16::MIN.into(), i16::MAX.into()) as i16
}

fn button_number(button: MouseButton) -> u8 {
    match button {
        MouseButton::Left => 1,
        MouseButton::Middle => 2,
        MouseButton::Right => 3,
    }
}

pub fn scroll_button(direction: ScrollDirection) -> u8 {
    match direction {
        ScrollDirection::Up => 4,
        ScrollDirection::Down => 5,
        ScrollDirection::Left => 6,
        ScrollDirection::Right => 7,
    }
}

impl Session {
    fn connect(name: &str, bindings: Bindings) -> Result<Self, String> {
        let open = |error: ConnectError| format!("Can't open display: {name}: {error}");
        let (conn, screen) = RustConnection::connect(Some(name)).map_err(open)?;
        let fd = conn.stream().as_raw_fd();
        let setup = conn.setup();
        let roots: Vec<Window> = setup.roots.iter().map(|screen| screen.root).collect();
        let root = setup.roots[screen].root;
        let failed = |error: ReplyError| format!("Can't open display: {name}: {error}");
        let names: [&[u8]; 8] = [
            b"_NET_ACTIVE_WINDOW",
            b"_NET_WM_NAME",
            b"_NET_WM_PID",
            b"_NET_SUPPORTED",
            b"_NET_WM_DESKTOP",
            b"_NET_CURRENT_DESKTOP",
            b"UTF8_STRING",
            b"AT_SPI_BUS",
        ];
        let cookies = names
            .iter()
            .map(|name| conn.intern_atom(false, name))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| failed(error.into()))?;
        let atoms = cookies
            .into_iter()
            .map(|cookie| cookie.reply().map(|reply| reply.atom))
            .collect::<Result<Vec<_>, _>>()
            .map_err(failed)?;
        let xtest = conn
            .extension_information(xtest::X11_EXTENSION_NAME)
            .map_err(|error| failed(error.into()))?
            .is_some();
        let session = Self {
            atoms: Atoms {
                net_active_window: atoms[0],
                net_wm_name: atoms[1],
                net_wm_pid: atoms[2],
                net_supported: atoms[3],
                net_wm_desktop: atoms[4],
                net_current_desktop: atoms[5],
                utf8_string: atoms[6],
                at_spi_bus: atoms[7],
            },
            conn,
            fd,
            root,
            roots,
            xtest,
            bindings,
        };
        // Best effort: a stale binding only costs one spare keycode.
        let _ = session.unbind_leftovers();
        Ok(session)
    }

    /// Unbinds spare keycodes an earlier session bound and could not unbind,
    /// when they still hold the keysym it set.
    fn unbind_leftovers(&self) -> XResult<()> {
        let leftovers = std::mem::take(&mut *self.bindings.lock().unwrap());
        if leftovers.is_empty() {
            return Ok(());
        }
        let keymap = self.keymap()?;
        let ours = leftovers
            .into_iter()
            .filter(|&(code, keysym)| keymap.keysyms(code).iter().all(|&sym| sym == keysym))
            .map(|(code, _)| Key {
                code,
                shift: false,
                bound: true,
            })
            .collect::<Vec<_>>();
        self.unbind(&keymap, &ours)
    }

    pub fn has_xtest(&self) -> bool {
        self.xtest
    }

    fn require_xtest(&self) -> XResult<()> {
        if self.xtest {
            Ok(())
        } else {
            Err("The X server has no XTEST extension".into())
        }
    }

    pub fn screen_size(&self) -> XResult<ScreenSize> {
        let geometry = self.conn.get_geometry(self.root)?.reply()?;
        if geometry.width == 0 || geometry.height == 0 {
            return Err(format!(
                "Unexpected display geometry: {} {}",
                geometry.width, geometry.height
            )
            .into());
        }
        Ok(ScreenSize {
            width: geometry.width.into(),
            height: geometry.height.into(),
        })
    }

    pub fn capture(&self, options: CaptureOptions) -> XResult<Vec<u8>> {
        let region = match options.region {
            Some(region) => region,
            None => {
                let size = self.screen_size()?;
                Region {
                    x: 0,
                    y: 0,
                    width: size.width,
                    height: size.height,
                }
            }
        };
        let (image, visual) = Image::get(
            &self.conn,
            self.root,
            clamp16(region.x),
            clamp16(region.y),
            region.width.clamp(1, u16::MAX.into()) as u16,
            region.height.clamp(1, u16::MAX.into()) as u16,
        )?;
        let mut rgb = self.to_rgb(&image, visual)?;
        if let Some(size) = options.size {
            rgb = rgb.resized(size);
        }
        let encoded = rgb.encode(options.format)?;
        if encoded.is_empty() {
            return Err("Screen capture returned no data".into());
        }
        Ok(encoded)
    }

    fn to_rgb(&self, image: &Image<'_>, visual: u32) -> XResult<RgbImage> {
        let visual_type = self
            .conn
            .setup()
            .roots
            .iter()
            .flat_map(|screen| &screen.allowed_depths)
            .flat_map(|depth| &depth.visuals)
            .find(|candidate| candidate.visual_id == visual)
            .copied()
            .ok_or("The root window has an unknown visual")?;
        let layout = PixelLayout::from_visual_type(visual_type)
            .map_err(|_| "The root window's visual is not true color")?;
        let (width, height) = (u32::from(image.width()), u32::from(image.height()));
        let bgrx = image.bits_per_pixel() == BitsPerPixel::B32
            && image.byte_order() == ImageOrder::LsbFirst
            && visual_type.red_mask == 0x00ff_0000
            && visual_type.green_mask == 0x0000_ff00
            && visual_type.blue_mask == 0x0000_00ff;
        if bgrx {
            let stride = image.data().len() / height.max(1) as usize;
            return Ok(RgbImage::from_bgrx(width, height, stride, image.data()));
        }
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 3);
        for y in 0..image.height() {
            for x in 0..image.width() {
                let (red, green, blue) = layout.decode(image.get_pixel(x, y));
                pixels.extend_from_slice(&[
                    (red >> 8) as u8,
                    (green >> 8) as u8,
                    (blue >> 8) as u8,
                ]);
            }
        }
        Ok(RgbImage {
            width,
            height,
            pixels,
        })
    }

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> XResult<()> {
        self.conn
            .xtest_fake_input(kind, detail, CURRENT_TIME, self.root, x, y, 0)?;
        Ok(())
    }

    fn flush(&self) -> XResult<()> {
        self.conn.sync()?;
        Ok(())
    }

    // Absolute XTest motion is processed ahead of later input, so there is no
    // need to wait for the pointer to arrive.
    pub fn move_to(&self, x: i64, y: i64) -> XResult<()> {
        self.require_xtest()?;
        self.fake(MOTION_NOTIFY_EVENT, 0, clamp16(x), clamp16(y))?;
        self.flush()
    }

    fn button(&self, button: u8, down: bool) -> XResult<()> {
        let kind = if down {
            BUTTON_PRESS_EVENT
        } else {
            BUTTON_RELEASE_EVENT
        };
        self.fake(kind, button, 0, 0)?;
        self.flush()
    }

    /// `xdotool click --repeat count --delay delay`.
    pub fn click(&self, button: u8, count: u32, delay: Duration) -> XResult<()> {
        self.require_xtest()?;
        for index in 0..count {
            if index > 0 {
                sleep(delay);
            }
            self.button(button, true)?;
            sleep(CLICK_HOLD);
            self.button(button, false)?;
        }
        Ok(())
    }

    pub fn mouse_button(&self, button: MouseButton, down: bool) -> XResult<()> {
        self.require_xtest()?;
        self.button(button_number(button), down)
    }

    pub fn button_for(button: MouseButton) -> u8 {
        button_number(button)
    }

    fn key_event(&self, code: Keycode, down: bool) -> XResult<()> {
        let kind = if down {
            KEY_PRESS_EVENT
        } else {
            KEY_RELEASE_EVENT
        };
        self.fake(kind, code, 0, 0)
    }

    fn keymap(&self) -> XResult<Keymap> {
        let setup = self.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = self
            .conn
            .get_keyboard_mapping(min, max - min + 1)?
            .reply()?;
        Ok(Keymap {
            min,
            per: reply.keysyms_per_keycode.into(),
            syms: reply.keysyms,
        })
    }

    fn resolve(&self, keymap: &mut Keymap, keysym: u32, taken: &mut Vec<Keycode>) -> XResult<Key> {
        if let Some((code, shift)) = keymap.find(keysym) {
            return Ok(Key {
                code,
                shift,
                bound: false,
            });
        }
        let code = keymap
            .spare(taken)
            .ok_or("No spare keycode is left to type this character")?;
        let syms = vec![keysym; keymap.per];
        self.bindings.lock().unwrap().push((code, keysym));
        self.conn
            .change_keyboard_mapping(1, code, keymap.per as u8, &syms)?;
        self.flush()?;
        taken.push(code);
        let start = (code - keymap.min) as usize * keymap.per;
        keymap.syms[start..start + keymap.per].copy_from_slice(&syms);
        Ok(Key {
            code,
            shift: false,
            bound: true,
        })
    }

    fn unbind(&self, keymap: &Keymap, keys: &[Key]) -> XResult<()> {
        let empty = vec![0u32; keymap.per];
        for key in keys.iter().filter(|key| key.bound) {
            self.conn
                .change_keyboard_mapping(1, key.code, keymap.per as u8, &empty)?;
        }
        self.flush()?;
        self.bindings
            .lock()
            .unwrap()
            .retain(|(code, _)| !keys.iter().any(|key| key.bound && key.code == *code));
        Ok(())
    }

    /// Unbinds `keys` and forgets them in the local keymap copy.
    fn release_bindings(&self, keymap: &mut Keymap, keys: &[Key]) -> XResult<()> {
        let unbound = self.unbind(keymap, keys);
        for key in keys.iter().filter(|key| key.bound) {
            let start = (key.code - keymap.min) as usize * keymap.per;
            keymap.syms[start..start + keymap.per].fill(0);
        }
        unbound
    }

    /// Presses `keys` in order with optional Shift, then releases them.
    fn tap(&self, keys: &[Key], shift: Option<Keycode>, delay: Duration) -> XResult<()> {
        if let Some(code) = shift {
            self.key_event(code, true)?;
        }
        for key in keys {
            self.key_event(key.code, true)?;
        }
        self.flush()?;
        sleep(delay / 2);
        for key in keys.iter().rev() {
            self.key_event(key.code, false)?;
        }
        if let Some(code) = shift {
            self.key_event(code, false)?;
        }
        self.flush()?;
        sleep(delay / 2);
        Ok(())
    }

    /// Releases held modifiers and Caps Lock, as `--clearmodifiers` does, and
    /// returns what to restore.
    fn clear_modifiers(&self, keymap: &Keymap) -> XResult<(Vec<Keycode>, Option<Keycode>)> {
        let modifiers = self.conn.get_modifier_mapping()?.reply()?;
        let pressed = self.conn.query_keymap()?.reply()?.keys;
        let is_pressed = |code: Keycode| pressed[code as usize / 8] & (1 << (code % 8)) != 0;
        let mut held: Vec<Keycode> = modifiers
            .keycodes
            .iter()
            .copied()
            .filter(|&code| code != 0 && is_pressed(code))
            .collect();
        held.dedup();
        let pointer = self.conn.query_pointer(self.root)?.reply()?;
        let caps = (u16::from(pointer.mask) & LOCK_MASK != 0)
            .then(|| keymap.find(CAPS_LOCK).map(|(code, _)| code))
            .flatten();
        for &code in &held {
            self.key_event(code, false)?;
        }
        if let Some(code) = caps {
            self.key_event(code, true)?;
            self.key_event(code, false)?;
        }
        self.flush()?;
        Ok((held, caps))
    }

    fn restore_modifiers(&self, (held, caps): (Vec<Keycode>, Option<Keycode>)) -> XResult<()> {
        if let Some(code) = caps {
            self.key_event(code, true)?;
            self.key_event(code, false)?;
        }
        for code in held {
            self.key_event(code, true)?;
        }
        self.flush()
    }

    fn shift_code(&self, keymap: &Keymap) -> XResult<Keycode> {
        keymap
            .find(SHIFT_L)
            .map(|(code, _)| code)
            .ok_or_else(|| "The keyboard has no Shift key".into())
    }

    /// `xdotool type --clearmodifiers --delay delay -- text`.
    pub fn type_text(&self, text: &str, delay: Duration) -> XResult<()> {
        self.require_xtest()?;
        let mut keymap = self.keymap()?;
        let cleared = self.clear_modifiers(&keymap)?;
        let result = (|| {
            for character in text.chars() {
                let mut taken = Vec::new();
                let key = self.resolve(&mut keymap, keys::char_keysym(character), &mut taken)?;
                let typed = if key.shift {
                    self.shift_code(&keymap)
                        .and_then(|code| self.tap(&[key], Some(code), delay))
                } else {
                    self.tap(&[key], None, delay)
                };
                let unbound = self.release_bindings(&mut keymap, &[key]);
                typed.and(unbound)?;
            }
            Ok(())
        })();
        let restored = self.restore_modifiers(cleared);
        result.and(restored)
    }

    /// `xdotool key --clearmodifiers --delay delay -- combos…`, with each combo
    /// already split into xdotool key names.
    pub fn key_combos(&self, combos: &[Vec<String>], delay: Duration) -> XResult<()> {
        self.require_xtest()?;
        let keysyms = combos
            .iter()
            .map(|combo| {
                combo
                    .iter()
                    .map(|name| {
                        keys::keysym(name).ok_or_else(|| format!("Unsupported key name: {name}"))
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut keymap = self.keymap()?;
        let cleared = self.clear_modifiers(&keymap)?;
        let result = (|| {
            for combo in &keysyms {
                let mut taken = Vec::new();
                let mut pressed = Vec::new();
                let typed = combo
                    .iter()
                    .try_for_each(|&keysym| {
                        pressed.push(self.resolve(&mut keymap, keysym, &mut taken)?);
                        Ok(())
                    })
                    .and_then(|()| {
                        if pressed.iter().any(|key| key.shift) && !combo.contains(&SHIFT_L) {
                            Ok(Some(self.shift_code(&keymap)?))
                        } else {
                            Ok(None)
                        }
                    })
                    .and_then(|shift| self.tap(&pressed, shift, delay));
                let unbound = self.release_bindings(&mut keymap, &pressed);
                typed.and(unbound)?;
            }
            Ok(())
        })();
        let restored = self.restore_modifiers(cleared);
        result.and(restored)
    }

    /// Presses or releases modifiers by xdotool name, without clearing others.
    /// Releasing tries every name, so one bad name cannot leave the rest held.
    pub fn modifiers(&self, names: &[String], down: bool) -> XResult<()> {
        self.require_xtest()?;
        let keymap = self.keymap()?;
        let mut outcome = Ok(());
        for name in names {
            let sent = keys::keysym(name)
                .ok_or_else(|| XError::from(format!("Unsupported modifier: {name}")))
                .and_then(|keysym| {
                    keymap
                        .find(keysym)
                        .ok_or_else(|| format!("The keyboard has no {name} key").into())
                })
                .and_then(|(code, _)| self.key_event(code, down));
            if let Err(error) = sent {
                if down || matches!(error, XError::Broken(_)) {
                    return Err(error);
                }
                outcome = outcome.and(Err(error));
            }
        }
        outcome.and(self.flush())
    }

    fn property(&self, window: Window, property: Atom, kind: Atom) -> XResult<Option<Vec<u8>>> {
        let reply = self
            .conn
            .get_property(false, window, property, kind, 0, 1 << 16)?
            .reply()?;
        Ok((reply.type_ != u32::from(AtomEnum::NONE)).then_some(reply.value))
    }

    fn cardinal(&self, window: Window, property: Atom, kind: AtomEnum) -> XResult<Option<u32>> {
        let reply = self
            .conn
            .get_property(false, window, property, kind, 0, 1)?
            .reply()?;
        Ok(reply.value32().and_then(|mut values| values.next()))
    }

    fn supports(&self, atom: Atom) -> XResult<bool> {
        let reply = self
            .conn
            .get_property(
                false,
                self.root,
                self.atoms.net_supported,
                AtomEnum::ATOM,
                0,
                1 << 16,
            )?
            .reply()?;
        Ok(reply
            .value32()
            .is_some_and(|mut atoms| atoms.any(|supported| supported == atom)))
    }

    /// The root window's `AT_SPI_BUS` string, set by the accessibility bus
    /// launcher.
    pub fn atspi_bus(&self) -> XResult<Option<String>> {
        let value = self.property(self.root, self.atoms.at_spi_bus, AtomEnum::ANY.into())?;
        Ok(value
            .map(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .trim_end_matches('\0')
                    .to_string()
            })
            .filter(|address| !address.is_empty()))
    }

    pub fn reports_active_window(&self) -> XResult<bool> {
        self.supports(self.atoms.net_active_window)
    }

    pub fn active_window(&self) -> XResult<Option<Window>> {
        Ok(self
            .cardinal(self.root, self.atoms.net_active_window, AtomEnum::WINDOW)?
            .filter(|window| *window != 0))
    }

    /// `_NET_WM_NAME`, else `WM_NAME`, as `xdotool getwindowname` reads it.
    pub fn window_name(&self, window: Window) -> XResult<String> {
        if let Some(name) = self
            .property(window, self.atoms.net_wm_name, self.atoms.utf8_string)?
            .filter(|name| !name.is_empty())
        {
            return Ok(String::from_utf8_lossy(&name).into_owned());
        }
        let reply = self
            .conn
            .get_property(false, window, AtomEnum::WM_NAME, AtomEnum::ANY, 0, 1 << 16)?
            .reply()?;
        Ok(if reply.type_ == u32::from(AtomEnum::STRING) {
            reply.value.iter().map(|&byte| char::from(byte)).collect()
        } else {
            String::from_utf8_lossy(&reply.value).into_owned()
        })
    }

    pub fn window_pid(&self, window: Window) -> XResult<Option<u32>> {
        Ok(self
            .cardinal(window, self.atoms.net_wm_pid, AtomEnum::CARDINAL)?
            .filter(|pid| *pid != 0))
    }

    /// Root-relative bounds, as `xdotool getwindowgeometry` reports them.
    fn window_bounds(&self, window: Window) -> XResult<Region> {
        let geometry = self.conn.get_geometry(window)?.reply()?;
        let tree = self.conn.query_tree(window)?.reply()?;
        let (x, y) = if tree.parent == geometry.root {
            (geometry.x, geometry.y)
        } else {
            let translated = self
                .conn
                .translate_coordinates(window, geometry.root, 0, 0)?
                .reply()?;
            (translated.dst_x, translated.dst_y)
        };
        Ok(Region {
            x: x.into(),
            y: y.into(),
            width: geometry.width.into(),
            height: geometry.height.into(),
        })
    }

    /// Every viewable window below `parent`, in the order of
    /// `xdotool search --onlyvisible --name ''`.
    fn viewable_windows(&self, parent: Window, found: &mut Vec<Window>) -> XResult<()> {
        let Ok(tree) = self.conn.query_tree(parent)?.reply() else {
            return Ok(());
        };
        let cookies = tree
            .children
            .iter()
            .map(|&child| self.conn.get_window_attributes(child))
            .collect::<Result<Vec<_>, _>>()?;
        for (child, cookie) in tree.children.iter().zip(cookies) {
            match cookie.reply() {
                Ok(attributes) if attributes.map_state == MapState::VIEWABLE => {
                    found.push(*child);
                }
                Ok(_) | Err(ReplyError::X11Error(_)) => {}
                Err(error) => return Err(error.into()),
            }
        }
        for &child in &tree.children {
            self.viewable_windows(child, found)?;
        }
        Ok(())
    }

    pub fn list_windows(&self) -> XResult<Vec<DesktopWindow>> {
        let mut ids = Vec::new();
        for &root in &self.roots {
            let attributes = self.conn.get_window_attributes(root)?.reply()?;
            if attributes.map_state == MapState::VIEWABLE {
                ids.push(root);
            }
            self.viewable_windows(root, &mut ids)?;
        }
        let focused = self.active_window().unwrap_or(None);
        let mut windows = Vec::new();
        for id in ids {
            if windows.len() >= MAX_WINDOWS {
                break;
            }
            let bounds = match self.window_bounds(id) {
                Ok(bounds) => bounds,
                Err(XError::Broken(message)) => return Err(XError::Broken(message)),
                Err(XError::Failed(_)) => continue,
            };
            if bounds.width <= 1 || bounds.height <= 1 {
                continue;
            }
            let title = match self.window_name(id) {
                Ok(title) => title,
                Err(XError::Broken(message)) => return Err(XError::Broken(message)),
                Err(XError::Failed(_)) => String::new(),
            };
            windows.push(DesktopWindow {
                id: id.to_string(),
                title,
                bounds,
                focused: Some(id) == focused,
            });
        }
        Ok(windows)
    }

    fn wait_until(&self, done: impl Fn() -> XResult<bool>) -> XResult<bool> {
        let deadline = Instant::now() + FOCUS_WAIT;
        loop {
            if done()? {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            sleep(FOCUS_POLL);
        }
    }

    fn client_message(&self, window: Window, kind: Atom, data: [u32; 5]) -> XResult<()> {
        let event = ClientMessageEvent::new(32, window, kind, data);
        self.conn.send_event(
            false,
            self.root,
            EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
            event,
        )?;
        self.flush()
    }

    /// `xdotool windowactivate --sync`, falling back to `windowfocus --sync`
    /// where the window manager does not support `_NET_ACTIVE_WINDOW`.
    pub fn focus_window(&self, window: Window) -> XResult<()> {
        self.conn.get_geometry(window)?.reply()?;
        if self.supports(self.atoms.net_active_window)? {
            if self.supports(self.atoms.net_wm_desktop)?
                && self.supports(self.atoms.net_current_desktop)?
                && let Some(desktop) =
                    self.cardinal(window, self.atoms.net_wm_desktop, AtomEnum::CARDINAL)?
                && desktop != u32::MAX
            {
                let current = self.cardinal(
                    self.root,
                    self.atoms.net_current_desktop,
                    AtomEnum::CARDINAL,
                )?;
                if current != Some(desktop) {
                    self.client_message(
                        self.root,
                        self.atoms.net_current_desktop,
                        [desktop, CURRENT_TIME, 0, 0, 0],
                    )?;
                }
            }
            self.client_message(
                window,
                self.atoms.net_active_window,
                [2, CURRENT_TIME, 0, 0, 0],
            )?;
            if self.wait_until(|| Ok(self.active_window()? == Some(window)))? {
                return Ok(());
            }
        }
        self.conn
            .set_input_focus(InputFocus::PARENT, window, CURRENT_TIME)?;
        self.flush()?;
        if self.wait_until(|| Ok(self.conn.get_input_focus()?.reply()?.focus == window))? {
            Ok(())
        } else {
            Err(format!("Window {window} did not take focus").into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_keys_by_shift_level_and_spare_keycodes() {
        let keymap = Keymap {
            min: 8,
            per: 2,
            syms: vec![0x61, 0x41, 0, 0, 0xffe1, 0, 0x31, 0x21, 0, 0],
        };
        assert_eq!(keymap.find(0x61), Some((8, false)));
        assert_eq!(keymap.find(0x41), Some((8, true)));
        assert_eq!(keymap.find(0x21), Some((11, true)));
        assert_eq!(keymap.find(0xe9), None);
        assert_eq!(keymap.spare(&[]), Some(12));
        assert_eq!(keymap.spare(&[12]), Some(9));
    }
}

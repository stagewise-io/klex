//! An AT-SPI2 client: application lookup, a bounded tree walk and live
//! re-reads of single elements. Handles are `bus|path` and stay valid while
//! the element lives.

use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, join_all};
use tokio::sync::Semaphore;
use tokio::time::Instant;
use zbus::{OwnedObjectPath, OwnedVariant};

use crate::desktop::provider::{
    AccessibilityElement, AccessibilityNode, AccessibilityQuery, AccessibilityTree, Region,
};

const REGISTRY: &str = "org.a11y.atspi.Registry";
const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
const NULL_PATH: &str = "/org/a11y/atspi/null";
const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const COMPONENT: &str = "org.a11y.atspi.Component";
const TEXT: &str = "org.a11y.atspi.Text";
const VALUE: &str = "org.a11y.atspi.Value";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const DBUS: &str = "org.freedesktop.DBus";
const COORD_SCREEN: u32 = 0;

pub const CALL_TIMEOUT: Duration = Duration::from_secs(2);
const WALK_DEADLINE: Duration = Duration::from_secs(4);
const MAX_VISITED: usize = 5_000;
const MAX_CHILDREN: usize = 200;
const CONCURRENCY: usize = 16;
const MAX_VALUE_CHARACTERS: usize = 200;
const WAKE_ATTEMPTS: u32 = 10;
const WAKE_INTERVAL: Duration = Duration::from_millis(100);

pub type BusResult<T> = Result<T, String>;
pub type BusFuture<'a, T> = BoxFuture<'a, BusResult<T>>;

/// The calls the client makes on one connection to the accessibility bus,
/// or on the session bus for `a11y_address`.
pub trait AtspiBus: Send + Sync {
    fn children(&self, bus: &str, path: &str) -> BusFuture<'static, Vec<(String, String)>>;
    fn role_name(&self, bus: &str, path: &str) -> BusFuture<'static, String>;
    fn state(&self, bus: &str, path: &str) -> BusFuture<'static, Vec<u32>>;
    /// `GetAttributes`, read only for its side effect on Chromium.
    fn attributes(&self, bus: &str, path: &str) -> BusFuture<'static, ()>;
    fn string_property(
        &self,
        bus: &str,
        path: &str,
        interface: &str,
        name: &str,
    ) -> BusFuture<'static, String>;
    fn number_property(
        &self,
        bus: &str,
        path: &str,
        interface: &str,
        name: &str,
    ) -> BusFuture<'static, f64>;
    fn extents(&self, bus: &str, path: &str) -> BusFuture<'static, (i32, i32, i32, i32)>;
    fn text(&self, bus: &str, path: &str, start: i32, end: i32) -> BusFuture<'static, String>;
    fn unix_process_id(&self, name: &str) -> BusFuture<'static, u32>;
    /// The accessibility bus address from the session bus launcher.
    fn a11y_address(&self) -> BusFuture<'static, String>;
    /// True once the transport failed; the client then reconnects.
    fn closed(&self) -> bool;
    /// Disconnects. Later calls fail and `closed` turns true.
    fn close(&self) -> BoxFuture<'static, ()>;
}

pub type AtspiConnector =
    Arc<dyn Fn(String) -> BusFuture<'static, Arc<dyn AtspiBus>> + Send + Sync>;
pub type AddressResolver = Arc<dyn Fn() -> BusFuture<'static, String> + Send + Sync>;

/// AtspiStateType bit positions, from at-spi2-core's atspi-constants.h.
mod state {
    pub const ACTIVE: u32 = 1;
    pub const CHECKED: u32 = 4;
    pub const COLLAPSED: u32 = 5;
    pub const DEFUNCT: u32 = 6;
    pub const EDITABLE: u32 = 7;
    pub const ENABLED: u32 = 8;
    pub const EXPANDABLE: u32 = 9;
    pub const EXPANDED: u32 = 10;
    pub const FOCUSABLE: u32 = 11;
    pub const FOCUSED: u32 = 12;
    pub const MODAL: u32 = 16;
    pub const PRESSED: u32 = 20;
    pub const SELECTED: u32 = 23;
    pub const SENSITIVE: u32 = 24;
    pub const SHOWING: u32 = 25;
    pub const INDETERMINATE: u32 = 32;
    pub const REQUIRED: u32 = 33;
    pub const CHECKABLE: u32 = 41;
    pub const READ_ONLY: u32 = 43;
}

const INTERACTIVE_ROLES: &[&str] = &[
    "check box",
    "check menu item",
    "combo box",
    "entry",
    "icon",
    "link",
    "list item",
    "menu",
    "menu item",
    "page tab",
    "password text",
    "push button",
    "radio button",
    "radio menu item",
    "slider",
    "spin button",
    "switch",
    "table cell",
    "toggle button",
    "tree item",
];

/// Unnamed nodes with these roles only group others and are left out.
const WRAPPER_ROLES: &[&str] = &[
    "filler",
    "grouping",
    "invalid",
    "layered pane",
    "panel",
    "redundant object",
    "scroll pane",
    "section",
    "split pane",
    "unknown",
    "viewport",
];

const VALUE_ROLES: &[&str] = &["progress bar", "scroll bar", "slider", "spin button"];

struct RawNode {
    bus: String,
    path: String,
    role: String,
    name: String,
    states: HashSet<u32>,
    children: Vec<(String, String)>,
}

impl RawNode {
    fn has(&self, bit: u32) -> bool {
        self.states.contains(&bit)
    }

    fn interactive(&self) -> bool {
        INTERACTIVE_ROLES.contains(&self.role.as_str())
            || (self.role == "text" && self.has(state::EDITABLE))
            || (self.has(state::FOCUSABLE) && !self.name.trim().is_empty())
    }

    fn state_names(&self) -> Vec<String> {
        let mut names = Vec::new();
        let mut push = |name: &str| names.push(name.to_string());
        if self.has(state::FOCUSED) {
            push("focused");
        }
        if self.has(state::CHECKED) {
            push("checked");
        } else if self.has(state::CHECKABLE) {
            push("unchecked");
        }
        if self.has(state::INDETERMINATE) {
            push("mixed");
        }
        if self.has(state::PRESSED) {
            push("pressed");
        }
        if self.has(state::SELECTED) {
            push("selected");
        }
        if self.has(state::EXPANDED) {
            push("expanded");
        } else if self.has(state::EXPANDABLE) || self.has(state::COLLAPSED) {
            push("collapsed");
        }
        if self.interactive() && !(self.has(state::ENABLED) || self.has(state::SENSITIVE)) {
            push("disabled");
        }
        if self.has(state::READ_ONLY) {
            push("read-only");
        }
        if self.has(state::REQUIRED) {
            push("required");
        }
        if self.has(state::MODAL) {
            push("modal");
        }
        names
    }
}

/// Fails with `message` when `future` takes longer than a D-Bus call may.
pub async fn with_timeout<T>(
    future: impl Future<Output = BusResult<T>>,
    message: &str,
) -> BusResult<T> {
    tokio::time::timeout(CALL_TIMEOUT, future)
        .await
        .unwrap_or_else(|_| Err(message.to_string()))
}

pub fn encode_handle(bus: &str, path: &str) -> String {
    format!("{bus}|{path}")
}

pub fn decode_handle(handle: &str) -> Result<(String, String), String> {
    match handle.split_once('|') {
        Some((bus, path)) if !bus.is_empty() && path.starts_with('/') => {
            Ok((bus.to_string(), path.to_string()))
        }
        _ => Err(format!("Invalid accessibility handle: {handle}")),
    }
}

pub struct AtspiClient {
    address: AddressResolver,
    connect: AtspiConnector,
    bus: tokio::sync::Mutex<Option<Arc<dyn AtspiBus>>>,
}

impl AtspiClient {
    pub fn new(address: AddressResolver, connect: AtspiConnector) -> Self {
        Self {
            address,
            connect,
            bus: tokio::sync::Mutex::new(None),
        }
    }

    /// True when the registry answers. Never fails.
    pub async fn available(&self) -> bool {
        match self.applications().await {
            Ok(_) => true,
            Err(_) => {
                self.close().await;
                false
            }
        }
    }

    pub async fn close(&self) {
        let bus = self.bus.lock().await.take();
        if let Some(bus) = bus {
            bus.close().await;
        }
    }

    async fn connection(&self) -> BusResult<Arc<dyn AtspiBus>> {
        let mut bus = self.bus.lock().await;
        if let Some(current) = bus.as_ref().filter(|current| !current.closed()) {
            return Ok(current.clone());
        }
        if let Some(stale) = bus.take() {
            stale.close().await;
        }
        let address = (self.address)().await?;
        let connected = (self.connect)(address).await?;
        *bus = Some(connected.clone());
        Ok(connected)
    }

    async fn call<T>(
        &self,
        member: &str,
        call: impl FnOnce(&dyn AtspiBus) -> BusFuture<'static, T>,
    ) -> BusResult<T> {
        let future = call(self.connection().await?.as_ref());
        with_timeout(future, &format!("{member} timed out")).await
    }

    async fn applications(&self) -> BusResult<Vec<(String, String)>> {
        self.children(REGISTRY, ROOT_PATH).await
    }

    async fn children(&self, bus: &str, path: &str) -> BusResult<Vec<(String, String)>> {
        let children = self
            .call("GetChildren", |connection| connection.children(bus, path))
            .await?;
        Ok(children
            .into_iter()
            .filter(|(_, path)| path != NULL_PATH)
            .collect())
    }

    async fn name(&self, bus: &str, path: &str) -> BusResult<String> {
        self.call("Get", |connection| {
            connection.string_property(bus, path, ACCESSIBLE, "Name")
        })
        .await
    }

    async fn states(&self, bus: &str, path: &str) -> BusResult<HashSet<u32>> {
        let words = self
            .call("GetState", |connection| connection.state(bus, path))
            .await?;
        let mut states = HashSet::new();
        for (index, word) in words.into_iter().enumerate() {
            for bit in 0..32 {
                if (word >> bit) & 1 == 1 {
                    states.insert(index as u32 * 32 + bit);
                }
            }
        }
        Ok(states)
    }

    /// The top-level frame of a window, matched by owning process first and
    /// by title second, or `None` when no application exposes it.
    pub async fn find_window(&self, pid: Option<u32>, title: &str) -> BusResult<Option<String>> {
        let apps = self.applications().await?;
        let mut owned = Vec::new();
        if let Some(pid) = pid {
            let owners = join_all(apps.iter().map(|app| async move {
                let found = self
                    .call("GetConnectionUnixProcessID", |connection| {
                        connection.unix_process_id(&app.0)
                    })
                    .await
                    .ok();
                (found == Some(pid)).then(|| app.clone())
            }))
            .await;
            owned.extend(owners.into_iter().flatten());
        }
        for (candidates, is_owned) in [(&owned, true), (&apps, false)] {
            let mut frames = Vec::new();
            for (bus, path) in candidates {
                let children = self.children(bus, path).await.unwrap_or_default();
                for (child_bus, child_path) in children {
                    let (name, states) = futures::join!(
                        self.name(&child_bus, &child_path),
                        self.states(&child_bus, &child_path)
                    );
                    frames.push((
                        encode_handle(&child_bus, &child_path),
                        name.unwrap_or_default(),
                        states.unwrap_or_default().contains(&state::ACTIVE),
                    ));
                }
            }
            let matched = frames
                .iter()
                .find(|(_, name, _)| name == title)
                .or_else(|| {
                    if !is_owned {
                        return None;
                    }
                    frames
                        .iter()
                        .find(|(_, _, active)| *active)
                        .or_else(|| (frames.len() == 1).then(|| &frames[0]))
                });
            if let Some((handle, _, _)) = matched {
                return Ok(Some(handle.clone()));
            }
        }
        Ok(None)
    }

    /// Chromium and Electron build their tree only after a client reads
    /// attributes, as Orca does. Waits briefly for children to appear.
    pub async fn wake(&self, handle: &str) -> BusResult<()> {
        let (bus, path) = decode_handle(handle)?;
        let _ = self
            .call("GetAttributes", |connection| {
                connection.attributes(&bus, &path)
            })
            .await;
        for _ in 0..WAKE_ATTEMPTS {
            let count = self
                .call("Get", |connection| {
                    connection.number_property(&bus, &path, ACCESSIBLE, "ChildCount")
                })
                .await
                .unwrap_or(0.0);
            if count > 0.0 {
                return Ok(());
            }
            tokio::time::sleep(WAKE_INTERVAL).await;
        }
        Ok(())
    }

    /// Pre-order, pruned walk of `handle`'s subtree.
    pub async fn tree(
        &self,
        handle: &str,
        query: &AccessibilityQuery,
    ) -> BusResult<AccessibilityTree> {
        let (bus, path) = decode_handle(handle)?;
        let walk = Walk {
            client: self,
            query,
            deadline: Instant::now() + WALK_DEADLINE,
            visited: AtomicUsize::new(0),
            kept: AtomicUsize::new(0),
            truncated: AtomicBool::new(false),
            limit: Semaphore::new(CONCURRENCY),
        };
        let result = walk.visit(bus.clone(), path, 0, 0, true).await;
        let Some(result) = result.filter(|out| out.node.is_some()) else {
            return Err("The accessibility element is gone".into());
        };
        let mut nodes = Vec::new();
        let mut truncated = walk.truncated.load(Ordering::SeqCst);
        flatten(result, query.max_nodes as usize, &mut nodes, &mut truncated);
        let application = self
            .name(&bus, ROOT_PATH)
            .await
            .ok()
            .filter(|name| !name.is_empty());
        Ok(AccessibilityTree {
            application,
            window: None,
            nodes,
            truncated,
        })
    }

    /// A live re-read, or `None` once the element is gone.
    pub async fn element(&self, handle: &str) -> BusResult<Option<AccessibilityElement>> {
        let (bus, path) = decode_handle(handle)?;
        let Ok(raw) = self.raw(bus, path).await else {
            return Ok(None);
        };
        if raw.has(state::DEFUNCT) || !raw.has(state::SHOWING) {
            return Ok(None);
        }
        Ok(Some(self.element_of(&raw).await))
    }

    async fn raw(&self, bus: String, path: String) -> BusResult<RawNode> {
        let (role, name, states, children) = futures::join!(
            self.call("GetRoleName", |connection| connection
                .role_name(&bus, &path)),
            self.name(&bus, &path),
            self.states(&bus, &path),
            self.children(&bus, &path),
        );
        Ok(RawNode {
            role: role?,
            name: name.unwrap_or_default(),
            states: states?,
            children: children.unwrap_or_default(),
            bus,
            path,
        })
    }

    async fn element_of(&self, raw: &RawNode) -> AccessibilityElement {
        let (bounds, value) = futures::join!(
            self.call("GetExtents", |connection| connection
                .extents(&raw.bus, &raw.path)),
            self.value(raw),
        );
        AccessibilityElement {
            handle: encode_handle(&raw.bus, &raw.path),
            role: raw.role.clone(),
            name: raw.name.trim().to_string(),
            value: value.ok().flatten(),
            states: raw.state_names(),
            bounds: bounds.ok().and_then(|(x, y, width, height)| {
                (width > 0 && height > 0).then_some(Region {
                    x: x.into(),
                    y: y.into(),
                    width: width.into(),
                    height: height.into(),
                })
            }),
        }
    }

    async fn value(&self, raw: &RawNode) -> BusResult<Option<String>> {
        if raw.role == "password text" {
            return Ok(None);
        }
        if VALUE_ROLES.contains(&raw.role.as_str()) {
            let value = self
                .call("Get", |connection| {
                    connection.number_property(&raw.bus, &raw.path, VALUE, "CurrentValue")
                })
                .await?;
            return Ok(Some(js_number(value)));
        }
        if raw.role == "entry"
            || raw.role == "combo box"
            || (raw.role == "text" && raw.has(state::EDITABLE))
        {
            let text = self
                .call("GetText", |connection| {
                    connection.text(&raw.bus, &raw.path, 0, MAX_VALUE_CHARACTERS as i32 + 1)
                })
                .await?;
            let units: Vec<u16> = text.encode_utf16().collect();
            return Ok(Some(if units.len() > MAX_VALUE_CHARACTERS {
                format!(
                    "{}…",
                    String::from_utf16_lossy(&units[..MAX_VALUE_CHARACTERS])
                )
            } else {
                text
            }));
        }
        Ok(None)
    }
}

/// `String(number)` for the values AT-SPI reports.
fn js_number(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

struct Out {
    node: Option<AccessibilityNode>,
    children: Vec<Out>,
}

struct Walk<'a> {
    client: &'a AtspiClient,
    query: &'a AccessibilityQuery,
    deadline: Instant,
    visited: AtomicUsize,
    kept: AtomicUsize,
    truncated: AtomicBool,
    limit: Semaphore,
}

impl Walk<'_> {
    fn visit(
        &self,
        bus: String,
        path: String,
        depth: u32,
        printed_depth: u32,
        root: bool,
    ) -> BoxFuture<'_, Option<Out>> {
        async move {
            // Parallel siblings mean a stopped walk may skip nodes before the
            // last kept one; the result is then marked truncated.
            if self.visited.load(Ordering::SeqCst) >= MAX_VISITED
                || self.kept.load(Ordering::SeqCst) >= self.query.max_nodes as usize
                || Instant::now() > self.deadline
            {
                self.truncated.store(true, Ordering::SeqCst);
                return None;
            }
            self.visited.fetch_add(1, Ordering::SeqCst);
            let raw = {
                let _permit = self.limit.acquire().await.ok()?;
                self.client.raw(bus, path).await.ok()?
            };
            if raw.has(state::DEFUNCT) || (!root && !raw.has(state::SHOWING)) {
                return None;
            }
            let keep = root
                || if self.query.interactive_only {
                    raw.interactive()
                } else {
                    !raw.name.trim().is_empty()
                        || raw.interactive()
                        || !WRAPPER_ROLES.contains(&raw.role.as_str())
                };
            let mut out = Out {
                node: None,
                children: Vec::new(),
            };
            if keep {
                let element = {
                    let _permit = self.limit.acquire().await.ok()?;
                    self.client.element_of(&raw).await
                };
                out.node = Some(AccessibilityNode {
                    element,
                    depth: printed_depth,
                });
                self.kept.fetch_add(1, Ordering::SeqCst);
            }
            if depth >= self.query.max_depth {
                if !raw.children.is_empty() {
                    self.truncated.store(true, Ordering::SeqCst);
                }
                return Some(out);
            }
            if raw.children.len() > MAX_CHILDREN {
                self.truncated.store(true, Ordering::SeqCst);
            }
            let next_printed = if out.node.is_some() {
                printed_depth + 1
            } else {
                printed_depth
            };
            out.children = join_all(
                raw.children
                    .into_iter()
                    .take(MAX_CHILDREN)
                    .map(|(bus, path)| self.visit(bus, path, depth + 1, next_printed, false)),
            )
            .await
            .into_iter()
            .flatten()
            .collect();
            Some(out)
        }
        .boxed()
    }
}

fn flatten(out: Out, max: usize, nodes: &mut Vec<AccessibilityNode>, truncated: &mut bool) {
    if let Some(node) = out.node {
        if nodes.len() >= max {
            *truncated = true;
            return;
        }
        nodes.push(node);
    }
    for child in out.children {
        flatten(child, max, nodes, truncated);
    }
}

/// The socket path of the first Unix transport in a D-Bus address, with
/// abstract sockets as `unix:abstract=`.
pub fn bus_address(address: &str) -> Result<String, String> {
    for transport in address.split(';') {
        let Some(("unix", params)) = transport.split_once(':') else {
            continue;
        };
        let params: Vec<(&str, String)> = params
            .split(',')
            .filter_map(|pair| pair.split_once('='))
            .map(|(key, value)| (key, percent_decode(value)))
            .collect();
        let get = |name: &str| {
            params
                .iter()
                .find(|(key, value)| *key == name && !value.is_empty())
                .map(|(_, value)| value.clone())
        };
        if let Some(path) = get("path") {
            return Ok(format!("unix:path={}", percent_encode(&path)));
        }
        if let Some(name) = get("abstract") {
            return Ok(format!("unix:abstract={}", percent_encode(&name)));
        }
    }
    Err(format!(
        "No Unix socket in accessibility bus address: {address}"
    ))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(byte) = value
                .get(index + 1..index + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            decoded.push(byte);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_/.\\*".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02x}"));
        }
    }
    encoded
}

/// A zbus connection to the accessibility or session bus.
#[derive(Clone)]
struct ZbusBus {
    connection: zbus::Connection,
    closed: Arc<AtomicBool>,
    _watcher: Arc<AbortOnDrop>,
}

/// The `closed()` watcher holds a connection clone, so it must stop with the
/// last `ZbusBus` or the socket would outlive every user.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn bus_error(error: zbus::Error) -> String {
    error.to_string()
}

impl ZbusBus {
    fn call<B, R>(
        &self,
        destination: &str,
        path: &str,
        interface: &'static str,
        member: &'static str,
        body: B,
    ) -> BusFuture<'static, R>
    where
        B: serde::Serialize + zbus::DynamicType + Send + Sync + 'static,
        R: for<'d> zbus::wire::DynamicDeserialize<'d> + Send + 'static,
    {
        let this = self.clone();
        let (destination, path) = (destination.to_string(), path.to_string());
        async move {
            let reply = this
                .connection
                .call_method(
                    Some(destination.as_str()),
                    path.as_str(),
                    Some(interface),
                    member,
                    &body,
                )
                .await
                .map_err(|error| {
                    if matches!(error, zbus::Error::InputOutput(_)) {
                        this.closed.store(true, Ordering::SeqCst);
                    }
                    bus_error(error)
                })?;
            reply.body().deserialize::<R>().map_err(bus_error)
        }
        .boxed()
    }

    fn property(
        &self,
        bus: &str,
        path: &str,
        interface: &str,
        name: &str,
    ) -> BusFuture<'static, OwnedVariant> {
        self.call(
            bus,
            path,
            PROPERTIES,
            "Get",
            (interface.to_string(), name.to_string()),
        )
    }
}

impl AtspiBus for ZbusBus {
    fn children(&self, bus: &str, path: &str) -> BusFuture<'static, Vec<(String, String)>> {
        let call = self.call::<_, Vec<(String, OwnedObjectPath)>>(
            bus,
            path,
            ACCESSIBLE,
            "GetChildren",
            (),
        );
        async move {
            Ok(call
                .await?
                .into_iter()
                .map(|(bus, path)| (bus, path.as_str().to_string()))
                .collect())
        }
        .boxed()
    }

    fn role_name(&self, bus: &str, path: &str) -> BusFuture<'static, String> {
        self.call(bus, path, ACCESSIBLE, "GetRoleName", ())
    }

    fn state(&self, bus: &str, path: &str) -> BusFuture<'static, Vec<u32>> {
        self.call(bus, path, ACCESSIBLE, "GetState", ())
    }

    fn attributes(&self, bus: &str, path: &str) -> BusFuture<'static, ()> {
        let call = self.call::<_, std::collections::HashMap<String, String>>(
            bus,
            path,
            ACCESSIBLE,
            "GetAttributes",
            (),
        );
        async move { call.await.map(drop) }.boxed()
    }

    fn string_property(
        &self,
        bus: &str,
        path: &str,
        interface: &str,
        name: &str,
    ) -> BusFuture<'static, String> {
        let call = self.property(bus, path, interface, name);
        async move { String::try_from(call.await?).map_err(|error| error.to_string()) }.boxed()
    }

    fn number_property(
        &self,
        bus: &str,
        path: &str,
        interface: &str,
        name: &str,
    ) -> BusFuture<'static, f64> {
        let call = self.property(bus, path, interface, name);
        let name = name.to_string();
        async move { variant_number(call.await?).ok_or_else(|| format!("{name} is not a number")) }
            .boxed()
    }

    fn extents(&self, bus: &str, path: &str) -> BusFuture<'static, (i32, i32, i32, i32)> {
        self.call(bus, path, COMPONENT, "GetExtents", (COORD_SCREEN,))
    }

    fn text(&self, bus: &str, path: &str, start: i32, end: i32) -> BusFuture<'static, String> {
        self.call(bus, path, TEXT, "GetText", (start, end))
    }

    fn unix_process_id(&self, name: &str) -> BusFuture<'static, u32> {
        self.call(
            DBUS,
            "/org/freedesktop/DBus",
            DBUS,
            "GetConnectionUnixProcessID",
            (name.to_string(),),
        )
    }

    fn a11y_address(&self) -> BusFuture<'static, String> {
        self.call(
            "org.a11y.Bus",
            "/org/a11y/bus",
            "org.a11y.Bus",
            "GetAddress",
            (),
        )
    }

    fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn close(&self) -> BoxFuture<'static, ()> {
        self.closed.store(true, Ordering::SeqCst);
        self._watcher.0.abort();
        let connection = self.connection.clone();
        async move {
            let _ = tokio::time::timeout(CALL_TIMEOUT, connection.close()).await;
        }
        .boxed()
    }
}

fn variant_number(value: OwnedVariant) -> Option<f64> {
    let attempt = |value: &OwnedVariant| value.try_clone().ok();
    f64::try_from(attempt(&value)?)
        .ok()
        .or_else(|| i32::try_from(attempt(&value)?).ok().map(f64::from))
        .or_else(|| u32::try_from(attempt(&value)?).ok().map(f64::from))
        .or_else(|| i64::try_from(attempt(&value)?).ok().map(|v| v as f64))
        .or_else(|| u64::try_from(value).ok().map(|v| v as f64))
}

/// Connects to a D-Bus bus by address, bounded by the call timeout.
pub fn connect_zbus(address: String) -> BusFuture<'static, Arc<dyn AtspiBus>> {
    async move {
        let address = bus_address(&address)?;
        let builder = zbus::connection::Builder::address(address.as_str());
        let connection = with_timeout(
            async { builder.build().await.map_err(bus_error) },
            "Accessibility bus connect timed out",
        )
        .await?;
        let closed = Arc::new(AtomicBool::new(false));
        let watcher = connection.clone();
        let flag = closed.clone();
        let watcher = AbortOnDrop(tokio::spawn(async move {
            watcher.closed().await;
            flag.store(true, Ordering::SeqCst);
        }));
        Ok(Arc::new(ZbusBus {
            connection,
            closed,
            _watcher: Arc::new(watcher),
        }) as Arc<dyn AtspiBus>)
    }
    .boxed()
}

#[cfg(test)]
pub mod fake {
    //! An in-memory AT-SPI2 registry and its applications behind `AtspiBus`.

    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    const STATE_BITS: &[(&str, u32)] = &[
        ("active", 1),
        ("checked", 4),
        ("defunct", 6),
        ("editable", 7),
        ("enabled", 8),
        ("focusable", 11),
        ("focused", 12),
        ("sensitive", 24),
        ("showing", 25),
        ("visible", 30),
        ("checkable", 41),
    ];

    #[derive(Clone, Default)]
    pub struct FakeElement {
        pub role: &'static str,
        pub name: &'static str,
        pub states: Vec<&'static str>,
        pub bounds: Option<(i32, i32, i32, i32)>,
        pub text: Option<&'static str>,
        pub value: Option<f64>,
        pub children: Vec<FakeElement>,
    }

    pub struct FakeApplication {
        pub bus: &'static str,
        pub pid: u32,
        pub name: &'static str,
        pub windows: Vec<FakeElement>,
    }

    struct Node {
        element: FakeElement,
        children: Vec<String>,
    }

    #[derive(Default)]
    struct State {
        nodes: HashMap<String, Node>,
        removed: HashSet<String>,
        by_name: HashMap<&'static str, String>,
    }

    struct App {
        bus: String,
        pid: u32,
        name: String,
        windows: Vec<String>,
    }

    #[derive(Clone)]
    pub struct FakeAtspi {
        apps: Arc<Vec<App>>,
        state: Arc<Mutex<State>>,
        pub calls: Arc<Mutex<Vec<(String, String, String)>>>,
        pub connections: Arc<Mutex<Vec<String>>>,
        pub a11y_address: String,
    }

    fn register(state: &mut State, next: &mut u32, element: &FakeElement) -> String {
        let path = format!("/org/a11y/atspi/accessible/{next}");
        *next += 1;
        let children = element
            .children
            .iter()
            .map(|child| register(state, next, child))
            .collect();
        if !element.name.is_empty() {
            state.by_name.insert(element.name, path.clone());
        }
        state.nodes.insert(
            path.clone(),
            Node {
                element: FakeElement {
                    children: Vec::new(),
                    ..element.clone()
                },
                children,
            },
        );
        path
    }

    impl FakeAtspi {
        pub fn new(applications: Vec<FakeApplication>) -> Self {
            let mut state = State::default();
            let mut next = 1;
            let apps = applications
                .iter()
                .map(|app| {
                    let windows = app
                        .windows
                        .iter()
                        .map(|window| register(&mut state, &mut next, window))
                        .collect();
                    App {
                        bus: app.bus.to_string(),
                        pid: app.pid,
                        name: app.name.to_string(),
                        windows,
                    }
                })
                .collect();
            Self {
                apps: Arc::new(apps),
                state: Arc::new(Mutex::new(state)),
                calls: Arc::default(),
                connections: Arc::default(),
                a11y_address: "unix:path=/tmp/fake-a11y".into(),
            }
        }

        fn path_of(&self, name: &str) -> String {
            self.state.lock().unwrap().by_name[name].clone()
        }

        /// Makes an element and its subtree vanish, as a closed dialog does.
        pub fn remove(&self, name: &str) {
            let path = self.path_of(name);
            let mut state = self.state.lock().unwrap();
            let mut pending = vec![path];
            while let Some(current) = pending.pop() {
                pending.extend(state.nodes[&current].children.clone());
                state.removed.insert(current);
            }
        }

        pub fn hide(&self, name: &str) {
            let path = self.path_of(name);
            let mut state = self.state.lock().unwrap();
            let node = state.nodes.get_mut(&path).unwrap();
            node.element.states.retain(|state| *state != "showing");
        }

        pub fn handle_of(&self, name: &str) -> String {
            let path = self.path_of(name);
            let bus = &self.apps[0].bus;
            encode_handle(bus, &path)
        }

        pub fn connector(&self) -> AtspiConnector {
            let fake = self.clone();
            Arc::new(move |address| {
                fake.connections.lock().unwrap().push(address.clone());
                let bus = FakeBus {
                    fake: fake.clone(),
                    address,
                };
                futures::future::ready(Ok(Arc::new(bus) as Arc<dyn AtspiBus>)).boxed()
            })
        }

        fn element(&self, bus: &str, path: &str) -> BusResult<FakeElement> {
            let state = self.state.lock().unwrap();
            let known = self.apps.iter().any(|app| app.bus == bus);
            match state.nodes.get(path) {
                Some(node) if known && !state.removed.contains(path) => Ok(node.element.clone()),
                _ => Err("org.freedesktop.DBus.Error.UnknownObject".into()),
            }
        }

        fn visible(&self, bus: &str, paths: &[String]) -> Vec<(String, String)> {
            let state = self.state.lock().unwrap();
            paths
                .iter()
                .filter(|path| !state.removed.contains(*path))
                .map(|path| (bus.to_string(), path.clone()))
                .collect()
        }
    }

    struct FakeBus {
        fake: FakeAtspi,
        address: String,
    }

    impl FakeBus {
        fn record(&self, destination: &str, member: &str) {
            self.fake.calls.lock().unwrap().push((
                destination.to_string(),
                member.to_string(),
                self.address.clone(),
            ));
        }

        fn ready<T: Send + 'static>(&self, value: BusResult<T>) -> BusFuture<'static, T> {
            futures::future::ready(value).boxed()
        }
    }

    impl AtspiBus for FakeBus {
        fn children(&self, bus: &str, path: &str) -> BusFuture<'static, Vec<(String, String)>> {
            self.record(bus, "GetChildren");
            if bus == REGISTRY && path == ROOT_PATH {
                let apps = self
                    .fake
                    .apps
                    .iter()
                    .map(|app| (app.bus.clone(), ROOT_PATH.to_string()))
                    .collect();
                return self.ready(Ok(apps));
            }
            if path == ROOT_PATH
                && let Some(app) = self.fake.apps.iter().find(|app| app.bus == bus)
            {
                return self.ready(Ok(self.fake.visible(bus, &app.windows)));
            }
            let result = self.fake.element(bus, path).map(|_| {
                let children = self.fake.state.lock().unwrap().nodes[path].children.clone();
                self.fake.visible(bus, &children)
            });
            self.ready(result)
        }

        fn role_name(&self, bus: &str, path: &str) -> BusFuture<'static, String> {
            self.record(bus, "GetRoleName");
            self.ready(
                self.fake
                    .element(bus, path)
                    .map(|element| element.role.to_string()),
            )
        }

        fn state(&self, bus: &str, path: &str) -> BusFuture<'static, Vec<u32>> {
            self.record(bus, "GetState");
            self.ready(self.fake.element(bus, path).map(|element| {
                let mut words = vec![0u32, 0];
                for name in element.states {
                    let bit = STATE_BITS.iter().find(|(key, _)| *key == name).unwrap().1;
                    words[(bit >> 5) as usize] |= 1 << (bit & 31);
                }
                words
            }))
        }

        fn attributes(&self, bus: &str, path: &str) -> BusFuture<'static, ()> {
            self.record(bus, "GetAttributes");
            self.ready(self.fake.element(bus, path).map(|_| ()))
        }

        fn string_property(
            &self,
            bus: &str,
            path: &str,
            interface: &str,
            name: &str,
        ) -> BusFuture<'static, String> {
            self.record(bus, "Get");
            if path == ROOT_PATH
                && name == "Name"
                && let Some(app) = self.fake.apps.iter().find(|app| app.bus == bus)
            {
                return self.ready(Ok(app.name.clone()));
            }
            let result = self.fake.element(bus, path).and_then(|element| {
                if interface == ACCESSIBLE && name == "Name" {
                    Ok(element.name.to_string())
                } else {
                    Err("org.freedesktop.DBus.Error.UnknownProperty".into())
                }
            });
            self.ready(result)
        }

        fn number_property(
            &self,
            bus: &str,
            path: &str,
            interface: &str,
            name: &str,
        ) -> BusFuture<'static, f64> {
            self.record(bus, "Get");
            let result = self.fake.element(bus, path).and_then(|element| {
                if interface == ACCESSIBLE && name == "ChildCount" {
                    let state = self.fake.state.lock().unwrap();
                    Ok(state.nodes[path].children.len() as f64)
                } else if interface == VALUE
                    && let Some(value) = element.value
                {
                    Ok(value)
                } else {
                    Err("org.freedesktop.DBus.Error.UnknownProperty".into())
                }
            });
            self.ready(result)
        }

        fn extents(&self, bus: &str, path: &str) -> BusFuture<'static, (i32, i32, i32, i32)> {
            self.record(bus, "GetExtents");
            self.ready(self.fake.element(bus, path).and_then(|element| {
                element
                    .bounds
                    .ok_or_else(|| "No Component interface".to_string())
            }))
        }

        fn text(&self, bus: &str, path: &str, start: i32, end: i32) -> BusFuture<'static, String> {
            self.record(bus, "GetText");
            self.ready(self.fake.element(bus, path).and_then(|element| {
                let text = element.text.ok_or("No Text interface")?;
                Ok(text
                    .chars()
                    .skip(start as usize)
                    .take((end - start) as usize)
                    .collect())
            }))
        }

        fn unix_process_id(&self, name: &str) -> BusFuture<'static, u32> {
            self.record(DBUS, "GetConnectionUnixProcessID");
            let pid = self
                .fake
                .apps
                .iter()
                .find(|app| app.bus == name)
                .map(|app| app.pid);
            self.ready(pid.ok_or_else(|| "org.freedesktop.DBus.Error.NameHasNoOwner".into()))
        }

        fn a11y_address(&self) -> BusFuture<'static, String> {
            self.record("org.a11y.Bus", "GetAddress");
            self.ready(Ok(self.fake.a11y_address.clone()))
        }

        fn closed(&self) -> bool {
            false
        }

        fn close(&self) -> BoxFuture<'static, ()> {
            self.record("", "Close");
            futures::future::ready(()).boxed()
        }
    }

    fn states(names: &[&'static str]) -> Vec<&'static str> {
        names.to_vec()
    }

    /// One terminal-like window with a mix of controls, labels and hidden nodes.
    pub fn sample_application() -> FakeApplication {
        let control = ["showing", "visible", "enabled", "sensitive", "focusable"];
        let editable = [
            "showing",
            "visible",
            "enabled",
            "sensitive",
            "editable",
            "focusable",
        ];
        FakeApplication {
            bus: ":1.42",
            pid: 777,
            name: "xfce4-terminal",
            windows: vec![FakeElement {
                role: "frame",
                name: "Terminal",
                states: states(&["active", "showing", "visible", "enabled", "sensitive"]),
                bounds: Some((0, 0, 800, 600)),
                children: vec![FakeElement {
                    role: "panel",
                    name: "",
                    states: states(&["showing", "visible"]),
                    bounds: Some((0, 0, 800, 600)),
                    children: vec![
                        FakeElement {
                            role: "push button",
                            name: "Save",
                            states: [control.as_slice(), &["focused"]].concat(),
                            bounds: Some((100, 50, 80, 30)),
                            ..Default::default()
                        },
                        FakeElement {
                            role: "entry",
                            name: "Search",
                            text: Some("hello"),
                            states: states(&editable),
                            bounds: Some((200, 50, 300, 30)),
                            ..Default::default()
                        },
                        FakeElement {
                            role: "password text",
                            name: "Password",
                            text: Some("secret"),
                            states: states(&editable),
                            bounds: Some((200, 100, 300, 30)),
                            ..Default::default()
                        },
                        FakeElement {
                            role: "check box",
                            name: "Remember",
                            states: states(&["showing", "visible", "checkable"]),
                            bounds: Some((200, 150, 20, 20)),
                            ..Default::default()
                        },
                        FakeElement {
                            role: "label",
                            name: "Status",
                            states: states(&["showing", "visible"]),
                            bounds: Some((0, 580, 800, 20)),
                            ..Default::default()
                        },
                        FakeElement {
                            role: "push button",
                            name: "Hidden",
                            states: states(&["visible", "enabled", "sensitive"]),
                            bounds: Some((0, 0, 10, 10)),
                            ..Default::default()
                        },
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    fn client(fake: &FakeAtspi) -> AtspiClient {
        AtspiClient::new(
            Arc::new(|| futures::future::ready(Ok("unix:path=/tmp/a11y".to_string())).boxed()),
            fake.connector(),
        )
    }

    fn query(interactive_only: bool, max_depth: u32, max_nodes: u32) -> AccessibilityQuery {
        AccessibilityQuery {
            window: None,
            root: None,
            interactive_only,
            max_depth,
            max_nodes,
        }
    }

    #[tokio::test]
    async fn prints_controls_skipping_hidden_nodes_wrappers_and_passwords() {
        let fake = FakeAtspi::new(vec![sample_application()]);
        let client = client(&fake);
        assert!(client.available().await);
        let frame = client
            .find_window(Some(777), "Terminal")
            .await
            .unwrap()
            .unwrap();
        let tree = client.tree(&frame, &query(true, 30, 300)).await.unwrap();
        assert_eq!(tree.application.as_deref(), Some("xfce4-terminal"));
        assert!(!tree.truncated);
        let summary: Vec<_> = tree
            .nodes
            .iter()
            .map(|node| {
                let element = &node.element;
                (
                    node.depth,
                    element.role.as_str(),
                    element.name.as_str(),
                    element.value.clone(),
                    element.states.clone(),
                    element.bounds.map(|b| (b.x, b.y, b.width, b.height)),
                )
            })
            .collect();
        let strings = |values: &[&str]| values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
        assert_eq!(
            summary,
            vec![
                (0, "frame", "Terminal", None, vec![], Some((0, 0, 800, 600))),
                (
                    1,
                    "push button",
                    "Save",
                    None,
                    strings(&["focused"]),
                    Some((100, 50, 80, 30))
                ),
                (
                    1,
                    "entry",
                    "Search",
                    Some("hello".into()),
                    vec![],
                    Some((200, 50, 300, 30))
                ),
                (
                    1,
                    "password text",
                    "Password",
                    None,
                    vec![],
                    Some((200, 100, 300, 30))
                ),
                (
                    1,
                    "check box",
                    "Remember",
                    None,
                    strings(&["unchecked", "disabled"]),
                    Some((200, 150, 20, 20))
                ),
            ]
        );

        let all = client.tree(&frame, &query(false, 30, 300)).await.unwrap();
        let names: Vec<_> = all.nodes.iter().map(|n| n.element.name.as_str()).collect();
        assert!(names.contains(&"Status"));
        assert!(!names.contains(&"Hidden"));
        assert!(!all.nodes.iter().any(|n| n.element.role == "panel"));
    }

    #[tokio::test]
    async fn marks_trees_cut_by_depth_or_size_as_truncated() {
        let fake = FakeAtspi::new(vec![sample_application()]);
        let client = client(&fake);
        let frame = fake.handle_of("Terminal");
        let shallow = client.tree(&frame, &query(true, 1, 300)).await.unwrap();
        assert_eq!(shallow.nodes.len(), 1);
        assert!(shallow.truncated);
        let small = client.tree(&frame, &query(true, 30, 2)).await.unwrap();
        assert_eq!(small.nodes.len(), 2);
        assert!(small.truncated);
    }

    #[tokio::test]
    async fn stops_walking_once_max_nodes_are_kept() {
        let fake = FakeAtspi::new(vec![sample_application()]);
        let client = client(&fake);
        client
            .tree(&fake.handle_of("Terminal"), &query(true, 30, 1))
            .await
            .unwrap();
        let reads = fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.1 == "GetRoleName")
            .count();
        assert!(reads < 4, "{reads}");
    }

    #[tokio::test]
    async fn matches_windows_by_process_then_title() {
        let fake = FakeAtspi::new(vec![sample_application()]);
        let client = client(&fake);
        let terminal = fake.handle_of("Terminal");
        assert_eq!(
            client.find_window(None, "Terminal").await.unwrap(),
            Some(terminal.clone())
        );
        assert_eq!(
            client.find_window(Some(777), "Other title").await.unwrap(),
            Some(terminal)
        );
        assert_eq!(
            client.find_window(Some(1), "Canvas game").await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn closes_the_bus_connection_on_close() {
        let fake = FakeAtspi::new(vec![sample_application()]);
        let client = client(&fake);
        assert!(client.available().await);
        client.close().await;
        assert!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .any(|(_, member, _)| member == "Close")
        );
    }

    #[tokio::test]
    async fn wakes_windows_by_reading_attributes() {
        let fake = FakeAtspi::new(vec![sample_application()]);
        let client = client(&fake);
        client.wake(&fake.handle_of("Terminal")).await.unwrap();
        assert!(fake.calls.lock().unwrap().contains(&(
            ":1.42".into(),
            "GetAttributes".into(),
            "unix:path=/tmp/a11y".into()
        )));
    }

    #[tokio::test]
    async fn re_reads_elements_and_reports_removed_or_hidden_ones_as_gone() {
        let fake = FakeAtspi::new(vec![sample_application()]);
        let client = client(&fake);
        let save = fake.handle_of("Save");
        let element = client.element(&save).await.unwrap().unwrap();
        assert_eq!(
            (element.role.as_str(), element.name.as_str()),
            ("push button", "Save")
        );
        fake.hide("Save");
        assert_eq!(client.element(&save).await.unwrap(), None);
        let search = fake.handle_of("Search");
        assert!(client.element(&search).await.unwrap().is_some());
        fake.remove("Search");
        assert_eq!(client.element(&search).await.unwrap(), None);
        assert_eq!(
            client
                .tree(&search, &query(true, 30, 300))
                .await
                .unwrap_err(),
            "The accessibility element is gone"
        );
    }

    #[test]
    fn parses_handles_and_bus_addresses() {
        assert_eq!(
            decode_handle(":1.42|/a/b").unwrap(),
            (":1.42".into(), "/a/b".into())
        );
        assert_eq!(
            decode_handle("nope").unwrap_err(),
            "Invalid accessibility handle: nope"
        );
        assert_eq!(
            bus_address("unix:path=/run/user/1000/at-spi/bus_1").unwrap(),
            "unix:path=/run/user/1000/at-spi/bus_1"
        );
        assert_eq!(
            bus_address("unix:abstract=/tmp/dbus-AbC,guid=0123456789abcdef").unwrap(),
            "unix:abstract=/tmp/dbus-AbC"
        );
        assert_eq!(
            bus_address("tcp:host=x,port=1;unix:path=/a%20b").unwrap(),
            "unix:path=/a%20b"
        );
        assert_eq!(
            bus_address("tcp:host=x,port=1").unwrap_err(),
            "No Unix socket in accessibility bus address: tcp:host=x,port=1"
        );
    }
}

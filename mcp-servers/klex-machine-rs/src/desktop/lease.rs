//! Who may send input to the desktop. Cloud decides; this enforces its last
//! decision locally and reverts to the agent when a human lease expires or
//! the Cloud connection stays down, so a lost connection cannot lock the
//! agent out.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::time::{iso, now_ms, parse_iso};

/// How long a human lease survives a lost Cloud control connection.
pub const LEASE_DISCONNECT_GRACE: Duration = Duration::from_secs(30);
pub const DESKTOP_CONTROLLED_BY_USER: &str = "desktop_controlled_by_user";
const UNNAMED_HOLDER: &str = "A person";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlMode {
    Agent,
    Human,
}

impl ControlMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Human => "human",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeReason {
    Cloud,
    Expired,
    Disconnected,
}

impl ChangeReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cloud => "cloud",
            Self::Expired => "expired",
            Self::Disconnected => "disconnected",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LeaseHolder {
    pub name: Option<String>,
    pub stream_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseUpdate {
    pub mode: ControlMode,
    pub holder: Option<LeaseHolder>,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlState {
    pub mode: ControlMode,
    /// Display name of the person in control; `None` in agent mode.
    pub holder: Option<String>,
    /// Only this viewer stream may send input; any stream when `None`.
    pub stream_id: Option<String>,
    pub expires_at: Option<String>,
}

impl ControlState {
    fn agent() -> Self {
        Self {
            mode: ControlMode::Agent,
            holder: None,
            stream_id: None,
            expires_at: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlChange {
    pub state: ControlState,
    pub reason: ChangeReason,
    pub sequence: u64,
    pub changed_at: String,
}

/// Agent input was refused because a person holds the desktop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputDenied {
    pub code: &'static str,
    pub message: String,
    pub holder: Option<String>,
}

pub type ControlListener = Arc<dyn Fn(&ControlChange) + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Inner {
    state: ControlState,
    expiry: Option<JoinHandle<()>>,
    grace: Option<JoinHandle<()>>,
    sequence: u64,
}

struct Shared {
    inner: Mutex<Inner>,
    listeners: Mutex<Vec<(u64, ControlListener)>>,
    next_listener: AtomicU64,
    now: Clock,
    grace: Duration,
}

#[derive(Clone)]
pub struct DesktopControlLease {
    shared: Arc<Shared>,
}

impl Default for DesktopControlLease {
    fn default() -> Self {
        Self::new()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn abort(handle: &mut Option<JoinHandle<()>>) {
    if let Some(handle) = handle.take() {
        handle.abort();
    }
}

impl DesktopControlLease {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(now_ms), LEASE_DISCONNECT_GRACE)
    }

    pub fn with_clock(now: Clock, grace: Duration) -> Self {
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    state: ControlState::agent(),
                    expiry: None,
                    grace: None,
                    sequence: 0,
                }),
                listeners: Mutex::default(),
                next_listener: AtomicU64::new(1),
                now,
                grace,
            }),
        }
    }

    pub fn state(&self) -> ControlState {
        lock(&self.shared.inner).state.clone()
    }

    pub fn authorize(&self) -> Result<(), InputDenied> {
        self.expire_if_due();
        let state = self.state();
        if state.mode != ControlMode::Human {
            return Ok(());
        }
        let holder = state.holder.unwrap_or_else(|| UNNAMED_HOLDER.into());
        Err(InputDenied {
            code: DESKTOP_CONTROLLED_BY_USER,
            message: format!(
                "{holder} is controlling this desktop. Wait for a desktop.control_changed notification with mode \"agent\" before sending input. Screenshots still work."
            ),
            holder: Some(holder),
        })
    }

    /// Whether RFB input from this viewer stream reaches the desktop.
    pub fn allows_stream_input(&self, stream_id: &str) -> bool {
        self.expire_if_due();
        let inner = lock(&self.shared.inner);
        inner.state.mode == ControlMode::Human
            && inner
                .state
                .stream_id
                .as_deref()
                .is_none_or(|id| id == stream_id)
    }

    pub fn apply(&self, update: LeaseUpdate) {
        let now = (self.shared.now)();
        let human = update.mode == ControlMode::Human;
        let expires_at = update
            .expires_at
            .as_deref()
            .filter(|value| human && !value.is_empty())
            .map(parse_iso);
        let mut inner = lock(&self.shared.inner);
        abort(&mut inner.grace);
        // A malformed expiry fails closed to the agent instead of an unbounded lease.
        if let Some(expiry) = expires_at
            && expiry.is_none_or(|expiry| expiry <= now)
        {
            self.set(inner, ControlState::agent(), ChangeReason::Expired);
            return;
        }
        let next = if human {
            let holder = update.holder.unwrap_or_default();
            let name = holder
                .name
                .as_deref()
                .map(|name| name.trim_matches(is_js_whitespace))
                .filter(|name| !name.is_empty())
                .unwrap_or(UNNAMED_HOLDER);
            ControlState {
                mode: ControlMode::Human,
                holder: Some(name.to_string()),
                stream_id: holder.stream_id.filter(|id| !id.is_empty()),
                expires_at: expires_at.flatten().map(iso),
            }
        } else {
            ControlState::agent()
        };
        self.set(inner, next, ChangeReason::Cloud);
    }

    /// Cloud's control connection dropped; Cloud resends the lease on reconnect.
    pub fn disconnected(&self) {
        let mut inner = lock(&self.shared.inner);
        if inner.state.mode != ControlMode::Human || inner.grace.is_some() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let weak = Arc::downgrade(&self.shared);
        let grace = self.shared.grace;
        inner.grace = Some(runtime.spawn(async move {
            tokio::time::sleep(grace).await;
            if let Some(lease) = upgrade(&weak) {
                let mut inner = lock(&lease.shared.inner);
                inner.grace = None;
                lease.set(inner, ControlState::agent(), ChangeReason::Disconnected);
            }
        }));
    }

    /// Returns a function that removes the listener.
    pub fn on_change(&self, listener: ControlListener) -> impl FnOnce() + Send + 'static {
        let id = self.shared.next_listener.fetch_add(1, Ordering::SeqCst);
        lock(&self.shared.listeners).push((id, listener));
        let weak = Arc::downgrade(&self.shared);
        move || {
            if let Some(shared) = weak.upgrade() {
                lock(&shared.listeners).retain(|(candidate, _)| *candidate != id);
            }
        }
    }

    pub fn close(&self) {
        let mut inner = lock(&self.shared.inner);
        abort(&mut inner.grace);
        abort(&mut inner.expiry);
        drop(inner);
        lock(&self.shared.listeners).clear();
    }

    fn set(
        &self,
        mut inner: std::sync::MutexGuard<'_, Inner>,
        next: ControlState,
        reason: ChangeReason,
    ) {
        abort(&mut inner.expiry);
        if let Some(expires_at) = next.expires_at.as_deref().and_then(parse_iso) {
            inner.expiry = self.schedule_expiry(expires_at);
        }
        let previous = std::mem::replace(&mut inner.state, next.clone());
        if previous.mode == next.mode && previous.holder == next.holder {
            return;
        }
        inner.sequence += 1;
        let change = ControlChange {
            state: next,
            reason,
            sequence: inner.sequence,
            changed_at: iso((self.shared.now)()),
        };
        drop(inner);
        let listeners: Vec<ControlListener> = lock(&self.shared.listeners)
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in listeners {
            // A failing subscriber must not block enforcement or other subscribers.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(&change)));
        }
    }

    fn schedule_expiry(&self, expires_at: i64) -> Option<JoinHandle<()>> {
        let runtime = tokio::runtime::Handle::try_current().ok()?;
        let weak = Arc::downgrade(&self.shared);
        Some(runtime.spawn(async move {
            loop {
                let Some(lease) = upgrade(&weak) else {
                    return;
                };
                let remaining = expires_at - (lease.shared.now)();
                drop(lease);
                if remaining <= 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(remaining as u64)).await;
            }
            if let Some(lease) = upgrade(&weak) {
                let mut inner = lock(&lease.shared.inner);
                inner.expiry = None;
                abort(&mut inner.grace);
                lease.set(inner, ControlState::agent(), ChangeReason::Expired);
            }
        }))
    }

    fn expire_if_due(&self) {
        let inner = lock(&self.shared.inner);
        if inner.state.mode != ControlMode::Human {
            return;
        }
        let Some(expires_at) = inner.state.expires_at.as_deref().and_then(parse_iso) else {
            return;
        };
        if expires_at > (self.shared.now)() {
            return;
        }
        let mut inner = inner;
        abort(&mut inner.grace);
        self.set(inner, ControlState::agent(), ChangeReason::Expired);
    }
}

fn upgrade(weak: &Weak<Shared>) -> Option<DesktopControlLease> {
    weak.upgrade().map(|shared| DesktopControlLease { shared })
}

/// `String.prototype.trim` whitespace.
fn is_js_whitespace(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicI64;

    fn clocked(start: i64) -> (DesktopControlLease, Arc<AtomicI64>) {
        let now = Arc::new(AtomicI64::new(start));
        let clock = now.clone();
        let lease = DesktopControlLease::with_clock(
            Arc::new(move || clock.load(Ordering::SeqCst)),
            Duration::from_millis(50),
        );
        (lease, now)
    }

    fn human(name: Option<&str>, stream: Option<&str>, expires_at: Option<String>) -> LeaseUpdate {
        LeaseUpdate {
            mode: ControlMode::Human,
            holder: Some(LeaseHolder {
                name: name.map(str::to_string),
                stream_id: stream.map(str::to_string),
            }),
            expires_at,
        }
    }

    #[test]
    fn a_human_lease_blocks_agent_input_and_admits_its_stream() {
        let (lease, _) = clocked(1_000_000);
        let changes = Arc::new(Mutex::new(Vec::new()));
        let seen = changes.clone();
        let _remove = lease.on_change(Arc::new(move |change: &ControlChange| {
            lock(&seen).push(change.clone());
        }));
        assert!(lease.authorize().is_ok());
        assert!(!lease.allows_stream_input("a"));
        lease.apply(human(Some("  Ada "), Some("a"), None));
        let denied = lease.authorize().unwrap_err();
        assert_eq!(denied.holder.as_deref(), Some("Ada"));
        assert!(
            denied
                .message
                .starts_with("Ada is controlling this desktop.")
        );
        assert!(lease.allows_stream_input("a"));
        assert!(!lease.allows_stream_input("b"));
        lease.apply(human(Some("Ada"), None, None));
        assert!(lease.allows_stream_input("b"));
        lease.apply(LeaseUpdate {
            mode: ControlMode::Agent,
            holder: None,
            expires_at: None,
        });
        let changes = lock(&changes);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].reason, ChangeReason::Cloud);
        assert_eq!(changes[0].sequence, 1);
        assert_eq!(changes[1].state.mode, ControlMode::Agent);
        assert_eq!(changes[1].sequence, 2);
    }

    #[test]
    fn expired_or_malformed_expiries_fail_closed_to_the_agent() {
        let (lease, now) = clocked(1_000_000);
        lease.apply(human(None, None, Some("nonsense".into())));
        assert_eq!(lease.state().mode, ControlMode::Agent);
        lease.apply(human(None, None, Some(iso(999_999))));
        assert_eq!(lease.state().mode, ControlMode::Agent);
        lease.apply(human(None, None, Some(iso(1_000_500))));
        assert_eq!(lease.state().holder.as_deref(), Some("A person"));
        assert_eq!(
            lease.state().expires_at.as_deref(),
            Some("1970-01-01T00:16:40.500Z")
        );
        now.store(1_000_500, Ordering::SeqCst);
        assert!(lease.authorize().is_ok());
        assert_eq!(lease.state().mode, ControlMode::Agent);
    }

    #[tokio::test]
    async fn a_lost_connection_returns_control_after_the_grace_period() {
        let (lease, _) = clocked(1_000_000);
        let reasons = Arc::new(Mutex::new(Vec::new()));
        let seen = reasons.clone();
        let _remove = lease.on_change(Arc::new(move |change: &ControlChange| {
            lock(&seen).push(change.reason);
        }));
        lease.apply(human(Some("Ada"), None, None));
        lease.disconnected();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(lease.state().mode, ControlMode::Agent);
        assert_eq!(
            *lock(&reasons),
            vec![ChangeReason::Cloud, ChangeReason::Disconnected]
        );
    }
}

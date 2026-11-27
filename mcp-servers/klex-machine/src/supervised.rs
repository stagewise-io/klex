//! `--supervised`: the status channel a parent process (Klex Desktop) reads
//! from this daemon. Status events go to stdout as one JSON object per line;
//! stdout carries nothing else in this mode. Commands arrive on stdin the
//! same way, and stdin closing means the parent is gone, so it counts as
//! `shutdown`.

use std::io::{BufRead, Write};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::cloud::proxy_daemon::LinkState;
use crate::cloud::token_client::OAUTH_ERROR_RESPONSE;

/// Bumped on incompatible changes; parents refuse other versions.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Connecting,
    Connected,
    /// Cloud is unreachable; the daemon keeps retrying.
    Offline,
    /// Cloud refused this machine; retrying continues but needs a person.
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StatusEvent {
    #[serde(rename_all = "camelCase")]
    Hello { protocol: u32, version: String },
    #[serde(rename_all = "camelCase")]
    Enrolled {
        machine_id: String,
        organization_name: Option<String>,
        reused: bool,
    },
    #[serde(rename_all = "camelCase")]
    State {
        state: ConnectionState,
        machine_id: String,
        organization_name: Option<String>,
        reason: Option<String>,
    },
    /// The command failed. `fatal` errors need a person; restarting the
    /// daemon will not fix them.
    #[serde(rename_all = "camelCase")]
    Error { message: String, fatal: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Shutdown,
}

pub fn hello() -> StatusEvent {
    StatusEvent::Hello {
        protocol: PROTOCOL_VERSION,
        version: crate::VERSION.into(),
    }
}

/// Maps the proxy link to the state shown to the person at the machine.
pub fn connection_state(link: &LinkState) -> (ConnectionState, Option<String>) {
    match link {
        LinkState::Connecting => (ConnectionState::Connecting, None),
        LinkState::Connected => (ConnectionState::Connected, None),
        LinkState::Offline(reason) if reason == OAUTH_ERROR_RESPONSE => (
            ConnectionState::Error,
            Some(
                "Klex Cloud no longer accepts this machine. It may have been deleted there.".into(),
            ),
        ),
        LinkState::Offline(reason) => (ConnectionState::Offline, Some(reason.clone())),
    }
}

static STDOUT: Mutex<()> = Mutex::new(());

/// Writes one event line and flushes, so the parent sees it at once.
pub fn emit(event: &StatusEvent) {
    let _guard = STDOUT.lock().unwrap_or_else(|error| error.into_inner());
    let line = serde_json::to_string(event).expect("serializable status event");
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

pub fn parse_command(line: &str) -> Option<Command> {
    serde_json::from_str(line.trim()).ok()
}

/// Reads one line of stdin, for `--code-stdin`. Later lines stay buffered in
/// `std::io::stdin()` for [`commands`].
pub fn read_stdin_line() -> Result<String, String> {
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|error| format!("Could not read the enrollment code from stdin: {error}"))?;
    Ok(line.trim().to_string())
}

/// Commands from stdin. Unknown lines are ignored; end of input yields
/// `Shutdown` once and closes the channel.
pub fn commands() -> mpsc::UnboundedReceiver<Command> {
    let (sender, receiver) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Some(command) = parse_command(&line)
                && sender.send(command).is_err()
            {
                return;
            }
        }
        let _ = sender.send(Command::Shutdown);
    });
    receiver
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_events_as_tagged_camel_case_lines() {
        let event = StatusEvent::State {
            state: ConnectionState::Connected,
            machine_id: "m1".into(),
            organization_name: Some("Org".into()),
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "type": "state",
                "state": "connected",
                "machineId": "m1",
                "organizationName": "Org",
                "reason": null,
            })
        );
        let line = serde_json::to_string(&hello()).unwrap();
        assert_eq!(serde_json::from_str::<StatusEvent>(&line).unwrap(), hello());
        assert!(!line.contains('\n'));
    }

    #[test]
    fn parses_commands_and_ignores_noise() {
        assert_eq!(
            parse_command("{\"type\":\"shutdown\"}\r\n"),
            Some(Command::Shutdown)
        );
        assert_eq!(parse_command("shutdown"), None);
        assert_eq!(parse_command("{\"type\":\"pause\"}"), None);
    }

    #[test]
    fn maps_rejected_credentials_to_error() {
        assert_eq!(
            connection_state(&LinkState::Offline("fetch failed".into())),
            (ConnectionState::Offline, Some("fetch failed".into()))
        );
        assert_eq!(
            connection_state(&LinkState::Offline(OAUTH_ERROR_RESPONSE.into())).0,
            ConnectionState::Error
        );
        assert_eq!(
            connection_state(&LinkState::Connected),
            (ConnectionState::Connected, None)
        );
    }
}

//! `@klex/machine`: an unrestricted filesystem and persistent shell MCP
//! server. Tool and server definitions live in `definitions/`. Behaviour,
//! messages and on-disk state stay compatible with the Node.js releases of
//! the package, which this crate replaced.

pub mod cli;
pub mod cloud;
pub mod collate;
pub mod config;
pub mod daemon;
pub mod desktop;
pub mod device_type;
pub mod filesystem;
pub mod fs_error;
pub mod glob;
pub mod icons;
pub mod logger;
pub mod mcp;
pub mod notifications;
pub mod paths;
pub mod platform;
pub mod push;
pub mod safe_regex;
pub mod schema;
pub mod search;
pub mod server;
pub mod shell;
pub mod supervised;
pub mod time;
pub mod utf16;
pub mod watchers;

/// Binary name used in help text and error prefixes.
pub const BIN_NAME: &str = "klex-machine";
/// Name advertised to MCP clients and in logs.
pub const SERVICE_NAME: &str = "klex-machine";
/// The npm release version when the release workflow sets
/// `KLEX_MACHINE_VERSION` at build time, else the crate version.
pub const VERSION: &str = match option_env!("KLEX_MACHINE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

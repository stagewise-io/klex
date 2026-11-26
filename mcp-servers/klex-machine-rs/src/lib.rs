//! Rust port of `@klex/machine`: an unrestricted filesystem and persistent
//! shell MCP server. Behaviour is defined by `mcp-servers/klex-machine/contract`
//! and checked against the TypeScript server by the conformance suite.

pub mod cli;
pub mod cloud;
pub mod collate;
pub mod config;
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
pub mod time;
pub mod utf16;
pub mod watchers;

/// Binary name used in help text and error prefixes.
pub const BIN_NAME: &str = "klex-machine-rs";
/// Name advertised to MCP clients and in logs; identical to the TS server.
pub const SERVICE_NAME: &str = "klex-machine";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

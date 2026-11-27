//! Pseudo-terminals with node-pty's observable behaviour.

use std::io::{self, Read};

use indexmap::IndexMap;

pub use super::os::pty::{EXIT_DRAIN, default_shell, default_shell_args, spawn};

pub struct SpawnOptions<'a> {
    pub shell: &'a str,
    pub args: &'a [String],
    pub cwd: &'a str,
    pub env: Option<&'a IndexMap<String, String>>,
    pub cols: u16,
    pub rows: u16,
}

pub struct Spawned {
    pub pid: u32,
    pub pty: Box<dyn Pty>,
    pub output: Box<dyn Read + Send>,
    pub child: Box<dyn Child>,
    /// The strerror text execvp(3) failed with. node-pty forks before exec,
    /// so such a shell still yields a session whose child exits 1.
    pub exec_failure: Option<&'static str>,
}

/// The terminal side of a running session.
pub trait Pty: Send + Sync {
    /// Writes and flushes input. A no-op once the terminal is released.
    fn write(&self, data: &[u8]) -> io::Result<()>;
    /// A no-op once the terminal is released.
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    /// node-pty's default `kill()`.
    fn hangup(&self);
}

pub trait Child: Send {
    /// Blocks until the shell exits and returns node-pty's `exitCode` and
    /// `signal`.
    fn wait(&mut self) -> (Option<i64>, Option<i64>);
}

/// portable-pty opens ConPTY with `PSEUDOCONSOLE_INHERIT_CURSOR`, so conhost
/// asks for the cursor position once and holds the shell until it gets an
/// answer. node-pty does not set that flag, so the query never reaches the
/// output. Output is held back while it ends in a prefix of the query.
#[cfg(any(windows, test))]
#[derive(Default)]
pub(super) struct CursorQuery {
    held: Vec<u8>,
    answered: bool,
}

#[cfg(any(windows, test))]
impl CursorQuery {
    const QUERY: &'static [u8] = b"\x1b[6n";

    /// Returns the output to keep, and whether the query arrived in it.
    pub(super) fn filter(&mut self, bytes: &[u8]) -> (Vec<u8>, bool) {
        if self.answered {
            return (bytes.to_vec(), false);
        }
        let mut data = std::mem::take(&mut self.held);
        data.extend_from_slice(bytes);
        if let Some(index) = data
            .windows(Self::QUERY.len())
            .position(|window| window == Self::QUERY)
        {
            self.answered = true;
            data.drain(index..index + Self::QUERY.len());
            return (data, true);
        }
        let partial = (1..Self::QUERY.len())
            .rev()
            .find(|&length| data.ends_with(&Self::QUERY[..length]))
            .unwrap_or(0);
        self.held = data.split_off(data.len() - partial);
        (data, false)
    }

    pub(super) fn end(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.held)
    }
}

#[cfg(test)]
mod tests {
    use super::CursorQuery;

    fn filter(query: &mut CursorQuery, text: &str) -> (String, bool) {
        let (kept, asked) = query.filter(text.as_bytes());
        (String::from_utf8(kept).unwrap(), asked)
    }

    #[test]
    fn strips_the_first_query_even_when_split() {
        let mut query = CursorQuery::default();
        assert_eq!(filter(&mut query, "a\x1b"), ("a".into(), false));
        assert_eq!(filter(&mut query, "["), (String::new(), false));
        assert_eq!(filter(&mut query, "6nb"), ("b".into(), true));
        assert_eq!(filter(&mut query, "\x1b[6n"), ("\x1b[6n".into(), false));
    }

    #[test]
    fn releases_held_output_that_is_not_the_query() {
        let mut query = CursorQuery::default();
        assert_eq!(filter(&mut query, "\x1b["), (String::new(), false));
        assert_eq!(filter(&mut query, "0m"), ("\x1b[0m".into(), false));
        assert_eq!(filter(&mut query, "x\x1b[6"), ("x".into(), false));
        assert_eq!(query.end(), b"\x1b[6");
    }
}

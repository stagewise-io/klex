//! The logs view: app events and the daemon's stderr, kept in memory for the
//! window and appended to a log file that rotates once at 5 MB.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

pub const MAX_LINES: usize = 2000;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const LOG_FILE: &str = "klex-desktop.log";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    App,
    Daemon,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LogLine {
    pub time: String,
    pub source: Source,
    pub message: String,
}

pub struct Logs {
    lines: Mutex<VecDeque<LogLine>>,
    file: Mutex<Option<(File, u64)>>,
    path: PathBuf,
}

impl Logs {
    pub fn new(directory: &Path) -> Self {
        let path = directory.join(LOG_FILE);
        let file = std::fs::create_dir_all(directory)
            .and_then(|()| open(&path))
            .ok();
        Self {
            lines: Mutex::new(VecDeque::with_capacity(MAX_LINES)),
            file: Mutex::new(file),
            path,
        }
    }

    pub fn directory(&self) -> &Path {
        self.path.parent().unwrap_or(&self.path)
    }

    /// Records a line and returns it for the live view.
    pub fn push(&self, source: Source, message: &str) -> LogLine {
        let line = LogLine {
            time: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            source,
            message: message.trim_end().to_string(),
        };
        {
            let mut lines = self.lines.lock().unwrap_or_else(|error| error.into_inner());
            if lines.len() == MAX_LINES {
                lines.pop_front();
            }
            lines.push_back(line.clone());
        }
        self.append(&line);
        line
    }

    pub fn snapshot(&self) -> Vec<LogLine> {
        let lines = self.lines.lock().unwrap_or_else(|error| error.into_inner());
        lines.iter().cloned().collect()
    }

    fn append(&self, line: &LogLine) {
        let mut file = self.file.lock().unwrap_or_else(|error| error.into_inner());
        let Some((handle, size)) = file.as_mut() else {
            return;
        };
        let source = match line.source {
            Source::App => "app",
            Source::Daemon => "daemon",
        };
        let text = format!("{} [{source}] {}\n", line.time, line.message);
        if handle.write_all(text.as_bytes()).is_ok() {
            *size += text.len() as u64;
        }
        if *size >= MAX_FILE_BYTES {
            *file = None;
            let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
            *file = open(&self.path).ok();
        }
    }
}

fn open(path: &Path) -> std::io::Result<(File, u64)> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let size = file.metadata()?.len();
    Ok((file, size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_lines_and_writes_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let logs = Logs::new(directory.path());
        for index in 0..MAX_LINES + 5 {
            logs.push(Source::Daemon, &format!("line {index}\n"));
        }
        let lines = logs.snapshot();
        assert_eq!(lines.len(), MAX_LINES);
        assert_eq!(lines[0].message, "line 5");
        assert_eq!(lines.last().unwrap().source, Source::Daemon);
        let text = std::fs::read_to_string(directory.path().join(LOG_FILE)).unwrap();
        assert!(text.ends_with(&format!("[daemon] line {}\n", MAX_LINES + 4)));
    }
}

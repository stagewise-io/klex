//! `--version` and `--help` must exit cleanly when nobody reads stdout. On
//! Windows a pipe whose reader is gone fails writes with ERROR_NO_DATA, which
//! is what PowerShell hands Klex Desktop's GUI-subsystem executable.

use std::process::{Command, Output, Stdio};

fn run_with_closed_stdout(arg: &str) -> Output {
    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    Command::new(env!("CARGO_BIN_EXE_klex-machine-rs"))
        .arg(arg)
        .stdout(writer)
        .stderr(Stdio::piped())
        .output()
        .unwrap()
}

#[test]
fn version_and_help_survive_a_closed_stdout() {
    for arg in ["--version", "--help"] {
        let output = run_with_closed_stdout(arg);
        assert!(
            output.status.success(),
            "{arg} exited with {:?}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
        );
    }
}

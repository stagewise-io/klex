// Release builds have no console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some(klex_desktop::DAEMON_FLAG) {
        return klex_machine::daemon::main(args.collect());
    }
    klex_desktop::run();
    ExitCode::SUCCESS
}

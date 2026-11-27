use std::process::ExitCode;

fn main() -> ExitCode {
    klex_machine::daemon::main(std::env::args().skip(1).collect())
}

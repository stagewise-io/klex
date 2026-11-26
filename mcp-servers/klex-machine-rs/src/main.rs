use std::collections::HashMap;
use std::process::ExitCode;

use klex_machine::cli::{CliResult, MachineMode, help_text, parse_cli};
use klex_machine::logger::Logger;
use klex_machine::server::{ServeOptions, serve};
use klex_machine::{BIN_NAME, VERSION};

const CLOUD_UNSUPPORTED: &str =
    "Klex Cloud modes are not yet supported by klex-machine-rs; use --mode local";

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let env: HashMap<String, String> = std::env::vars().collect();
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => return fail(&error.to_string()),
    };
    let result = match parse_cli(&argv, &env, &cwd) {
        Ok(result) => result,
        Err(message) => return fail(&message),
    };
    match result {
        CliResult::Help => {
            println!("{}", help_text());
            ExitCode::SUCCESS
        }
        CliResult::Version => {
            println!("{VERSION}");
            ExitCode::SUCCESS
        }
        CliResult::Serve {
            config,
            data_dir,
            mode: MachineMode::Local,
            omit_host_details,
        } => {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => return fail(&error.to_string()),
            };
            let logger = Logger::stderr(config.log_level);
            match runtime.block_on(serve(
                ServeOptions {
                    config,
                    data_dir,
                    omit_host_details,
                },
                logger,
            )) {
                Ok(()) => ExitCode::SUCCESS,
                Err(message) => fail(&message),
            }
        }
        CliResult::Serve { .. } | CliResult::Enroll { .. } | CliResult::ManagedBootstrap { .. } => {
            fail(CLOUD_UNSUPPORTED)
        }
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("{BIN_NAME}: {message}");
    ExitCode::FAILURE
}

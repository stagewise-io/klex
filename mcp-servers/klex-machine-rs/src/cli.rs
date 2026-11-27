use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::config::{RawRuntimeConfig, RuntimeConfig, resolve_runtime_config};
use crate::paths::resolve_from;
use crate::{BIN_NAME, VERSION};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MachineMode {
    Local,
    Enrolled,
    Managed,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EnrollmentCode {
    Argument(String),
    /// `--code-stdin`: the first line of stdin, so the code stays out of
    /// process listings.
    Stdin,
}

#[derive(Debug)]
pub enum CliResult {
    Help,
    Version,
    Enroll {
        cloud_base_url: String,
        code: EnrollmentCode,
        data_dir: PathBuf,
        serve: Option<(RuntimeConfig, bool)>,
        supervised: bool,
    },
    ManagedBootstrap {
        cloud_base_url: String,
        config: RuntimeConfig,
        data_dir: PathBuf,
        enrollment_code_file: String,
        omit_host_details: bool,
    },
    Serve {
        config: RuntimeConfig,
        data_dir: PathBuf,
        mode: MachineMode,
        omit_host_details: bool,
        supervised: bool,
    },
}

const STRING_OPTIONS: [&str; 8] = [
    "cwd",
    "host",
    "port",
    "log-level",
    "mode",
    "data-dir",
    "cloud-base-url",
    "enrollment-code-file",
];
const BOOLEAN_OPTIONS: [&str; 6] = [
    "serve",
    "omit-host-details",
    "help",
    "version",
    "code-stdin",
    "supervised",
];

#[derive(Default)]
struct Parsed {
    strings: HashMap<&'static str, String>,
    booleans: HashMap<&'static str, bool>,
    positionals: Vec<String>,
}

/// `util.parseArgs` with `strict`, `allowPositionals` and `allowNegative`.
fn parse_args(argv: &[String]) -> Result<Parsed, String> {
    let unknown = |token: &str| {
        format!(
            "Unknown option '{token}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{token}\""
        )
    };
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        index += 1;
        if token == "--" {
            parsed.positionals.extend(argv[index..].iter().cloned());
            break;
        }
        if let Some(long) = token.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (long, None),
            };
            if let Some(option) = STRING_OPTIONS.iter().find(|option| **option == name) {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        let Some(next) = argv.get(index) else {
                            return Err(format!("Option '--{name} <value>' argument missing"));
                        };
                        if next.len() > 1 && next.starts_with('-') {
                            return Err(format!(
                                "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                            ));
                        }
                        index += 1;
                        next.clone()
                    }
                };
                parsed.strings.insert(option, value);
                continue;
            }
            if let Some(option) = BOOLEAN_OPTIONS.iter().find(|option| **option == name) {
                if inline.is_some() {
                    return Err(format!("Option '--{name}' does not take an argument"));
                }
                parsed.booleans.insert(option, true);
                continue;
            }
            if let Some(negated) = name.strip_prefix("no-")
                && let Some(option) = BOOLEAN_OPTIONS.iter().find(|option| **option == negated)
            {
                if inline.is_some() {
                    return Err(format!("Option '--{name}' does not take an argument"));
                }
                parsed.booleans.insert(option, false);
                continue;
            }
            return Err(unknown(token));
        }
        if token.len() > 1 && token.starts_with('-') {
            for short in token[1..].chars() {
                match short {
                    'h' => parsed.booleans.insert("help", true),
                    'v' => parsed.booleans.insert("version", true),
                    _ => return Err(unknown(&format!("-{short}"))),
                };
            }
            continue;
        }
        parsed.positionals.push(token.clone());
    }
    Ok(parsed)
}

pub fn default_data_dir() -> PathBuf {
    let home = crate::platform::host::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".klex-machine-rs")
}

pub fn parse_cli(
    argv: &[String],
    env: &HashMap<String, String>,
    process_cwd: &Path,
) -> Result<CliResult, String> {
    let parsed = parse_args(argv)?;
    if parsed.booleans.get("help") == Some(&true) {
        return Ok(CliResult::Help);
    }
    if parsed.booleans.get("version") == Some(&true) {
        return Ok(CliResult::Version);
    }
    let string = |name: &str| parsed.strings.get(name).cloned();
    let env_var = |name: &str| env.get(name).cloned();

    let omit_host_details = match parsed.booleans.get("omit-host-details") {
        Some(value) => *value,
        None => omit_host_details_from_env(
            env.get("KLEX_MACHINE_OMIT_HOST_DETAILS")
                .map(String::as_str),
        )?,
    };
    let data_dir = match string("data-dir").or_else(|| env_var("KLEX_MACHINE_DATA_DIR")) {
        Some(dir) => resolve_from(process_cwd, Path::new(&dir)),
        None => resolve_from(process_cwd, &default_data_dir()),
    };
    let positionals = &parsed.positionals;
    let (command, subcommand, value) =
        (positionals.first(), positionals.get(1), positionals.get(2));
    let extra = positionals.len() > 3;
    let cloud_base_url = string("cloud-base-url")
        .or_else(|| env_var("KLEX_MACHINE_CLOUD_BASE_URL"))
        .unwrap_or_else(|| "https://cloud.klex.bot".into());
    let raw = RawRuntimeConfig {
        cwd: string("cwd").or_else(|| env_var("KLEX_MACHINE_CWD")),
        host: string("host").or_else(|| env_var("KLEX_MACHINE_HOST")),
        port: string("port").or_else(|| env_var("KLEX_MACHINE_PORT")),
        log_level: string("log-level").or_else(|| env_var("KLEX_MACHINE_LOG_LEVEL")),
    };
    let serve = parsed.booleans.get("serve").copied();
    let code_stdin = parsed.booleans.get("code-stdin") == Some(&true);
    let supervised = parsed.booleans.get("supervised") == Some(&true);
    let enroll = command.map(String::as_str) == Some("cloud")
        && subcommand.map(String::as_str) == Some("enroll")
        && !extra;
    let code_argument = value.filter(|value| !value.is_empty());

    if enroll && code_stdin && code_argument.is_some() {
        return Err("--code-stdin cannot be used with a code argument".into());
    }
    if code_stdin && !enroll {
        return Err("--code-stdin is only valid with cloud enroll".into());
    }
    if enroll && (code_stdin || code_argument.is_some()) {
        if parsed.strings.contains_key("mode") {
            return Err("--mode cannot be used with cloud enroll".into());
        }
        let code = match code_argument {
            Some(code) => EnrollmentCode::Argument(code.clone()),
            None => EnrollmentCode::Stdin,
        };
        if serve == Some(false) {
            return Ok(CliResult::Enroll {
                cloud_base_url,
                code,
                data_dir,
                serve: None,
                supervised,
            });
        }
        let local_only: Vec<String> = ["host", "port", "log-level"]
            .iter()
            .filter(|name| parsed.strings.contains_key(**name))
            .map(|name| format!("--{name}"))
            .collect();
        if !local_only.is_empty() {
            return Err(format!(
                "{} only apply to --mode local",
                local_only.join(", ")
            ));
        }
        let config = resolve_runtime_config(
            &RawRuntimeConfig {
                cwd: raw.cwd,
                ..Default::default()
            },
            process_cwd,
        )?;
        return Ok(CliResult::Enroll {
            cloud_base_url,
            code,
            data_dir,
            serve: Some((config, omit_host_details)),
            supervised,
        });
    }
    if serve.is_some() {
        return Err("--serve and --no-serve are only valid with cloud enroll".into());
    }
    if supervised && command.map(String::as_str) == Some("cloud") {
        return Err("--supervised is only valid with serve and cloud enroll".into());
    }
    if command.map(String::as_str) == Some("cloud")
        && subcommand.map(String::as_str) == Some("bootstrap")
        && value.is_none_or(String::is_empty)
        && !extra
    {
        let Some(enrollment_code_file) = string("enrollment-code-file")
            .or_else(|| env_var("KLEX_MACHINE_ENROLLMENT_CODE_FILE"))
            .filter(|file| !file.is_empty())
        else {
            return Err("Managed bootstrap requires --enrollment-code-file <path|->".into());
        };
        return Ok(CliResult::ManagedBootstrap {
            cloud_base_url,
            config: resolve_runtime_config(&raw, process_cwd)?,
            data_dir,
            enrollment_code_file,
            omit_host_details,
        });
    }
    if command.is_some_and(|command| command != "serve")
        || subcommand.is_some_and(|value| !value.is_empty())
        || value.is_some_and(|value| !value.is_empty())
        || extra
    {
        return Err(format!(
            "Expected command: {BIN_NAME} serve, {BIN_NAME} cloud enroll <code>, or {BIN_NAME} cloud bootstrap"
        ));
    }
    let mode = match string("mode")
        .or_else(|| env_var("KLEX_MACHINE_MODE"))
        .as_deref()
        .unwrap_or("enrolled")
    {
        "local" => MachineMode::Local,
        "enrolled" => MachineMode::Enrolled,
        "managed" => MachineMode::Managed,
        _ => return Err("Invalid mode. Expected local, enrolled, or managed.".into()),
    };
    if supervised && mode != MachineMode::Enrolled {
        return Err("--supervised only applies to --mode enrolled".into());
    }
    Ok(CliResult::Serve {
        config: resolve_runtime_config(&raw, process_cwd)?,
        data_dir,
        mode,
        omit_host_details,
        supervised,
    })
}

fn omit_host_details_from_env(value: Option<&str>) -> Result<bool, String> {
    match value.map(str::to_lowercase).as_deref() {
        None => Ok(false),
        Some("1" | "true") => Ok(true),
        Some("0" | "false") => Ok(false),
        Some(_) => {
            Err("Invalid KLEX_MACHINE_OMIT_HOST_DETAILS. Expected 1/true or 0/false.".into())
        }
    }
}

pub fn help_text() -> String {
    format!(
        "{BIN_NAME} {VERSION}

Usage:
  {BIN_NAME} serve [options]
  {BIN_NAME} cloud enroll <code> [--no-serve] [options]
  {BIN_NAME} cloud enroll --code-stdin [--no-serve] [options]
  {BIN_NAME} cloud bootstrap --enrollment-code-file <path|-> [options]

Options:
  --cwd <path>        Default working directory
  --host <address>    Local mode listener address (default: 127.0.0.1)
  --port <number>     Local mode listener port (default: 3123)
  --log-level <level> Local mode: trace, debug, info, warn, error, or fatal
  --mode <mode>       local, enrolled, or managed (default: enrolled)
  --data-dir <path>   Identity and notification state directory (default: ~/.klex-machine-rs)
  --cloud-base-url <url> Cloud API URL used for enrollment
  --enrollment-code-file <path|-> Read and remove a one-time code file, or read stdin with -
  --code-stdin        Read the enrollment code from the first line of stdin
  --no-serve          Enroll only; do not start serving
  --supervised        Report status as JSON lines on stdout and accept
                      commands on stdin, for a supervising app
  --omit-host-details Omit hostname, workspace path and disk size from Cloud facts.
                      Otherwise these are visible to organization members through the API.
                      Removes stored host details on the next accepted report.
  -h, --help          Show help
  -v, --version       Show version

cloud enroll serves after enrolling; keep the process running to stay
connected. Re-running it with the same code restarts without re-enrolling.

Environment:
  KLEX_MACHINE_CWD
  KLEX_MACHINE_HOST
  KLEX_MACHINE_PORT
  KLEX_MACHINE_LOG_LEVEL
  KLEX_MACHINE_MODE
  KLEX_MACHINE_DATA_DIR
  KLEX_MACHINE_CLOUD_BASE_URL
  KLEX_MACHINE_ENROLLMENT_CODE_FILE
  KLEX_MACHINE_OMIT_HOST_DETAILS (1/true or 0/false; default: false)"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<CliResult, String> {
        let argv: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        parse_cli(&argv, &HashMap::new(), &std::env::temp_dir())
    }

    #[test]
    fn mirrors_parse_args_errors() {
        assert!(
            parse(&["--foo"])
                .unwrap_err()
                .starts_with("Unknown option '--foo'.")
        );
        assert_eq!(
            parse(&["--cwd"]).unwrap_err(),
            "Option '--cwd <value>' argument missing"
        );
        assert_eq!(
            parse(&["--serve=x"]).unwrap_err(),
            "Option '--serve' does not take an argument"
        );
        assert!(
            parse(&["--port", "--serve"])
                .unwrap_err()
                .starts_with("Option '--port' argument is ambiguous.")
        );
        assert!(matches!(parse(&["-hv"]), Ok(CliResult::Help)));
        assert!(matches!(parse(&["-v"]), Ok(CliResult::Version)));
    }

    #[test]
    fn validates_commands() {
        assert_eq!(
            parse(&["nope"]).unwrap_err(),
            "Expected command: klex-machine-rs serve, klex-machine-rs cloud enroll <code>, or klex-machine-rs cloud bootstrap"
        );
        assert_eq!(
            parse(&["--mode", "x"]).unwrap_err(),
            "Invalid mode. Expected local, enrolled, or managed."
        );
        assert_eq!(
            parse(&["--no-serve"]).unwrap_err(),
            "--serve and --no-serve are only valid with cloud enroll"
        );
        assert_eq!(
            parse(&["cloud", "enroll", "c", "--mode", "local"]).unwrap_err(),
            "--mode cannot be used with cloud enroll"
        );
        assert_eq!(
            parse(&["cloud", "enroll", "c", "--port", "1"]).unwrap_err(),
            "--port only apply to --mode local"
        );
        assert_eq!(
            parse(&["cloud", "bootstrap"]).unwrap_err(),
            "Managed bootstrap requires --enrollment-code-file <path|->"
        );
        assert_eq!(
            parse(&["cloud", "enroll", "c", "--code-stdin"]).unwrap_err(),
            "--code-stdin cannot be used with a code argument"
        );
        assert_eq!(
            parse(&["serve", "--code-stdin"]).unwrap_err(),
            "--code-stdin is only valid with cloud enroll"
        );
        assert_eq!(
            parse(&["serve", "--mode", "local", "--supervised"]).unwrap_err(),
            "--supervised only applies to --mode enrolled"
        );
        assert_eq!(
            parse(&["cloud", "bootstrap", "--supervised"]).unwrap_err(),
            "--supervised is only valid with serve and cloud enroll"
        );
        assert!(matches!(
            parse(&[
                "cloud",
                "enroll",
                "--code-stdin",
                "--no-serve",
                "--supervised"
            ]),
            Ok(CliResult::Enroll {
                code: EnrollmentCode::Stdin,
                serve: None,
                supervised: true,
                ..
            })
        ));
        assert!(matches!(
            parse(&["cloud", "enroll", "ABCD"]),
            Ok(CliResult::Enroll {
                code: EnrollmentCode::Argument(_),
                serve: Some(_),
                supervised: false,
                ..
            })
        ));
        assert!(matches!(
            parse(&["serve", "--supervised"]),
            Ok(CliResult::Serve {
                supervised: true,
                ..
            })
        ));
        assert!(matches!(
            parse(&["serve", "--mode", "local"]),
            Ok(CliResult::Serve {
                mode: MachineMode::Local,
                ..
            })
        ));
        assert!(matches!(
            parse(&[]),
            Ok(CliResult::Serve {
                mode: MachineMode::Enrolled,
                ..
            })
        ));
    }
}

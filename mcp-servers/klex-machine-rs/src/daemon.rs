//! The `klex-machine-rs` command. Lives in the library so apps that link the
//! crate, such as Klex Desktop, can run it by re-executing themselves.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::cli::{CliResult, EnrollmentCode, MachineMode, help_text, parse_cli};
use crate::cloud::auth::{Authenticator, ProtectedResource, load_protected_resource};
use crate::cloud::enrollment::{bootstrap_managed_machine, connect_machine};
use crate::cloud::facts::{
    MachineFactsCollector, MachineFactsOptions, encode_machine_facts_header,
};
use crate::cloud::machine_live_message;
use crate::cloud::principal_router::{PrincipalRouter, PrincipalRouterOptions};
use crate::cloud::proxy_daemon::LinkState;
use crate::cloud::runtime::{start_cloud_runtime, start_supervised_cloud_runtime};
use crate::cloud::state::{MachineEnrollment, load_machine_enrollment};
use crate::config::RuntimeConfig;
use crate::desktop::{self, service::DesktopService};
use crate::logger::Logger;
use crate::notifications::NotificationStore;
use crate::platform::desktop::host_main_thread;
use crate::platform::signals;
use crate::server::{ServeOptions, serve};
use crate::supervised::{self, StatusEvent};
use crate::{BIN_NAME, VERSION};

/// Runs the command line `argv` (without the program name).
pub fn main(argv: Vec<String>) -> ExitCode {
    let env: HashMap<String, String> = std::env::vars().collect();
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => return fail(&error.to_string(), false),
    };
    let supervised = argv.iter().any(|arg| arg == "--supervised");
    let result = match parse_cli(&argv, &env, &cwd) {
        Ok(result) => result,
        Err(message) => return fail(&message, supervised),
    };
    match result {
        CliResult::Help => print_line(&help_text()),
        CliResult::Version => print_line(VERSION),
        command => {
            if supervised {
                supervised::emit(&supervised::hello());
            }
            match host_main_thread(move || {
                tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())?
                    .block_on(run(command))
            }) {
                Ok(code) => code,
                Err(message) => fail(&message, supervised),
            }
        }
    }
}

/// Writes `text` to stdout. Unlike `println!`, a reader that has gone away
/// ends the command quietly instead of panicking; on Windows that includes
/// PowerShell capturing a GUI-subsystem executable such as Klex Desktop.
fn print_line(text: &str) -> ExitCode {
    match writeln!(std::io::stdout().lock(), "{text}") {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(
                std::io::stderr(),
                "{BIN_NAME}: cannot write to stdout: {error}"
            );
            ExitCode::FAILURE
        }
    }
}

/// Prints to stdout unless stdout is the supervised status channel. A closed
/// stream drops the message rather than taking the daemon down.
fn say(supervised: bool, message: &str) {
    let _ = if supervised {
        writeln!(std::io::stderr(), "{message}")
    } else {
        writeln!(std::io::stdout(), "{message}")
    };
}

async fn run(command: CliResult) -> Result<ExitCode, String> {
    match command {
        CliResult::Help | CliResult::Version => Ok(ExitCode::SUCCESS),
        CliResult::Serve {
            config,
            data_dir,
            mode: MachineMode::Local,
            omit_host_details,
            ..
        } => {
            let logger = Logger::stderr(config.log_level);
            let desktop = desktop_from_environment(&logger, &data_dir);
            serve(
                ServeOptions {
                    config,
                    data_dir,
                    omit_host_details,
                    desktop,
                },
                logger,
            )
            .await
        }
        CliResult::Serve {
            config,
            data_dir,
            omit_host_details,
            supervised: true,
            ..
        } => serve_supervised(config, data_dir, omit_host_details).await,
        CliResult::Serve {
            config,
            data_dir,
            omit_host_details,
            ..
        } => serve_cloud(config, data_dir, omit_host_details, true).await,
        CliResult::Enroll {
            cloud_base_url,
            code,
            data_dir,
            serve,
            supervised,
        } => {
            let code = match code {
                EnrollmentCode::Argument(code) => code,
                EnrollmentCode::Stdin => supervised::read_stdin_line()?,
            };
            let connected = connect_machine(&cloud_base_url, &code, &data_dir).await?;
            let machine_id = &connected.enrollment.machine_id;
            if supervised {
                supervised::emit(&StatusEvent::Enrolled {
                    machine_id: machine_id.clone(),
                    organization_name: connected.enrollment.organization_name.clone(),
                    reused: connected.reused,
                });
            }
            if connected.reused {
                say(
                    supervised,
                    &format!(
                        "Already enrolled as machine {machine_id}; enrollment code not used again."
                    ),
                );
            } else {
                say(supervised, &format!("Enrolled machine {machine_id}"));
            }
            let Some((config, omit_host_details)) = serve else {
                if !supervised {
                    println!("Start it with: {BIN_NAME}");
                }
                return Ok(ExitCode::SUCCESS);
            };
            if supervised {
                return serve_supervised(config, data_dir, omit_host_details).await;
            }
            println!("Connecting to Klex Cloud...");
            serve_cloud(config, data_dir, omit_host_details, true).await
        }
        CliResult::ManagedBootstrap {
            cloud_base_url,
            config,
            data_dir,
            enrollment_code_file,
            omit_host_details,
        } => {
            bootstrap_managed_machine(&cloud_base_url, &data_dir, &enrollment_code_file).await?;
            serve_cloud(config, data_dir, omit_host_details, false).await
        }
    }
}

struct Served {
    router: Arc<PrincipalRouter>,
    store: Arc<NotificationStore>,
}

impl Served {
    async fn close(self) -> ExitCode {
        let router_closed = self.router.close().await;
        let store_closed = self.store.close().await;
        if router_closed.and(store_closed).is_ok() {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        }
    }
}

async fn principal_router(
    config: &RuntimeConfig,
    data_dir: &std::path::Path,
    enrollment: &MachineEnrollment,
    protected_resource: ProtectedResource,
    omit_host_details: bool,
    desktop: Option<Arc<DesktopService>>,
    logger: &Logger,
) -> Result<Served, String> {
    let store = Arc::new(NotificationStore::new(Some(data_dir), logger.clone()));
    store.ready().await.map_err(|error| error.0)?;
    let router = Arc::new(PrincipalRouter::new(PrincipalRouterOptions {
        authenticator: Authenticator::new(
            protected_resource.issuer,
            protected_resource.resource,
            format!("{}/api/auth/jwks", enrollment.cloud_base_url),
            &enrollment.oauth_protected_resource_url,
        ),
        default_cwd: config.cwd.clone(),
        store: store.clone(),
        logger: logger.clone(),
        omit_host_details,
        desktop,
    }));
    Ok(Served { router, store })
}

fn facts(config: &RuntimeConfig, omit_host_details: bool) -> Option<MachineFactsOptions> {
    Some(MachineFactsOptions {
        cwd: config.cwd.clone(),
        omit_host_details,
        version: VERSION.into(),
    })
}

async fn serve_cloud(
    config: RuntimeConfig,
    data_dir: PathBuf,
    omit_host_details: bool,
    announce: bool,
) -> Result<ExitCode, String> {
    let logger = Logger::stderr(config.log_level);
    let desktop = desktop_from_environment(&logger, &data_dir);
    let enrollment = load_machine_enrollment(&data_dir)?;
    let protected_resource = load_protected_resource(
        &enrollment.oauth_protected_resource_url,
        &enrollment.mcp_resource_url,
    )
    .await?;
    let served = principal_router(
        &config,
        &data_dir,
        &enrollment,
        protected_resource,
        omit_host_details,
        desktop.clone(),
        &logger,
    )
    .await?;
    let handler_router = served.router.clone();
    let runtime = start_cloud_runtime(
        &data_dir,
        Arc::new(move |request| {
            let router = handler_router.clone();
            Box::pin(async move { router.fetch(request).await })
        }),
        facts(&config, omit_host_details),
        desktop,
        logger,
    )
    .await;
    let runtime = match runtime {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = served.close().await;
            return Err(error);
        }
    };
    let first = signals::shutdown();
    if announce {
        println!("{}", machine_live_message(&enrollment.machine_id));
    }
    let first = first.await;
    // The TS runtime registers one-shot listeners and never removes the other
    // one, so only a repeat of an already-handled signal is fatal.
    tokio::spawn(async move {
        let mut handled = vec![first];
        loop {
            let signal = signals::shutdown().await;
            if handled.contains(&signal) {
                signals::terminate_by(signal);
            }
            handled.push(signal);
        }
    });
    runtime.close().await;
    Ok(served.close().await)
}

const METADATA_RETRY_MAXIMUM: Duration = Duration::from_secs(30);

/// Cloud mode for a supervising app: never exits because Cloud is
/// unreachable, reports every link change, and stops on `shutdown`, on stdin
/// closing, or on a signal.
async fn serve_supervised(
    config: RuntimeConfig,
    data_dir: PathBuf,
    omit_host_details: bool,
) -> Result<ExitCode, String> {
    let logger = Logger::stderr(config.log_level);
    let desktop = desktop_from_environment(&logger, &data_dir);
    let mut commands = supervised::commands();
    let stop = async move {
        tokio::select! {
            _ = commands.recv() => {}
            _ = signals::shutdown() => {}
        }
    };
    tokio::pin!(stop);

    let enrollment = load_machine_enrollment(&data_dir)?;
    let report = |link: &LinkState| {
        let (state, reason) = supervised::connection_state(link);
        supervised::emit(&StatusEvent::State {
            state,
            machine_id: enrollment.machine_id.clone(),
            organization_name: enrollment.organization_name.clone(),
            reason,
        });
    };
    report(&LinkState::Connecting);

    let mut delay = Duration::from_secs(1);
    let protected_resource = loop {
        let attempt = load_protected_resource(
            &enrollment.oauth_protected_resource_url,
            &enrollment.mcp_resource_url,
        );
        tokio::select! {
            result = attempt => match result {
                Ok(resource) => break resource,
                Err(error) => report(&LinkState::Offline(error)),
            },
            () = &mut stop => return Ok(ExitCode::SUCCESS),
        }
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = &mut stop => return Ok(ExitCode::SUCCESS),
        }
        delay = (delay * 2).min(METADATA_RETRY_MAXIMUM);
    };

    let served = principal_router(
        &config,
        &data_dir,
        &enrollment,
        protected_resource,
        omit_host_details,
        desktop.clone(),
        &logger,
    )
    .await?;
    let handler_router = served.router.clone();
    if let Some(options) = facts(&config, omit_host_details) {
        describe_facts(MachineFactsCollector::new(options)).await;
    }
    eprintln!(
        "Machine {} connects to {}",
        enrollment.machine_id, enrollment.proxy_connection_url
    );
    let (status, mut links) = mpsc::unbounded_channel();
    let runtime = start_supervised_cloud_runtime(
        &data_dir,
        Arc::new(move |request| {
            let router = handler_router.clone();
            Box::pin(async move { router.fetch(request).await })
        }),
        facts(&config, omit_host_details),
        desktop,
        logger,
        status,
    )
    .await;
    let runtime = match runtime {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = served.close().await;
            return Err(error);
        }
    };
    let mut last = LinkState::Connecting;
    loop {
        tokio::select! {
            link = links.recv() => {
                let Some(link) = link else { break };
                if link != last {
                    report(&link);
                    last = link;
                }
            }
            () = &mut stop => break,
        }
    }
    runtime.close().await;
    Ok(served.close().await)
}

fn desktop_from_environment(logger: &Logger, data_dir: &Path) -> Option<Arc<DesktopService>> {
    let logger = logger.clone();
    desktop::desktop_from_environment(
        Arc::new(move |message: &str| {
            logger.warn(serde_json::json!({ "source": "desktop" }), message);
        }),
        Some(data_dir),
    )
}

/// Logs the facts each connection reports, so a Cloud that shows no OS can be
/// told apart from a daemon that sends none.
async fn describe_facts(collector: MachineFactsCollector) {
    let facts = collector.collect().await;
    match encode_machine_facts_header(&facts) {
        Some(header) => eprintln!(
            "Reporting machine facts: {} {}{} ({} byte header)",
            facts.os.name.as_deref().unwrap_or(&facts.os.platform),
            facts.os.arch,
            facts
                .os
                .release
                .as_deref()
                .map(|release| format!(", release {release}"))
                .unwrap_or_default(),
            header.len()
        ),
        None => eprintln!("Machine facts exceed the header size limit and are not reported"),
    }
}

fn fail(message: &str, supervised: bool) -> ExitCode {
    if supervised {
        supervised::emit(&StatusEvent::Error {
            message: message.into(),
            fatal: true,
        });
    }
    eprintln!("{BIN_NAME}: {message}");
    ExitCode::FAILURE
}

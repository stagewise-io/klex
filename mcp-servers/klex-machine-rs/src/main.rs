use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use klex_machine::cli::{CliResult, MachineMode, help_text, parse_cli};
use klex_machine::cloud::auth::{Authenticator, load_protected_resource};
use klex_machine::cloud::enrollment::{bootstrap_managed_machine, connect_machine};
use klex_machine::cloud::facts::MachineFactsOptions;
use klex_machine::cloud::machine_live_message;
use klex_machine::cloud::principal_router::{PrincipalRouter, PrincipalRouterOptions};
use klex_machine::cloud::runtime::start_cloud_runtime;
use klex_machine::cloud::state::load_machine_enrollment;
use klex_machine::config::RuntimeConfig;
use klex_machine::desktop::{self, service::DesktopService};
use klex_machine::logger::Logger;
use klex_machine::notifications::NotificationStore;
use klex_machine::platform::desktop::host_main_thread;
use klex_machine::platform::signals;
use klex_machine::server::{ServeOptions, serve};
use klex_machine::{BIN_NAME, VERSION};

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
        command => match host_main_thread(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?
                .block_on(run(command))
        }) {
            Ok(code) => code,
            Err(message) => fail(&message),
        },
    }
}

async fn run(command: CliResult) -> Result<ExitCode, String> {
    match command {
        CliResult::Help | CliResult::Version => Ok(ExitCode::SUCCESS),
        CliResult::Serve {
            config,
            data_dir,
            mode: MachineMode::Local,
            omit_host_details,
        } => {
            let logger = Logger::stderr(config.log_level);
            let desktop = desktop_from_environment(&logger);
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
            ..
        } => serve_cloud(config, data_dir, omit_host_details, true).await,
        CliResult::Enroll {
            cloud_base_url,
            code,
            data_dir,
            serve,
        } => {
            let connected = connect_machine(&cloud_base_url, &code, &data_dir).await?;
            let machine_id = &connected.enrollment.machine_id;
            if connected.reused {
                println!(
                    "Already enrolled as machine {machine_id}; enrollment code not used again."
                );
            } else {
                println!("Enrolled machine {machine_id}");
            }
            let Some((config, omit_host_details)) = serve else {
                println!("Start it with: {BIN_NAME}");
                return Ok(ExitCode::SUCCESS);
            };
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

async fn serve_cloud(
    config: RuntimeConfig,
    data_dir: PathBuf,
    omit_host_details: bool,
    announce: bool,
) -> Result<ExitCode, String> {
    let logger = Logger::stderr(config.log_level);
    let desktop = desktop_from_environment(&logger);
    let enrollment = load_machine_enrollment(&data_dir)?;
    let protected_resource = load_protected_resource(
        &enrollment.oauth_protected_resource_url,
        &enrollment.mcp_resource_url,
    )
    .await?;
    let store = Arc::new(NotificationStore::new(Some(&data_dir), logger.clone()));
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
        desktop: desktop.clone(),
    }));
    let handler_router = router.clone();
    let runtime = start_cloud_runtime(
        &data_dir,
        Arc::new(move |request| {
            let router = handler_router.clone();
            Box::pin(async move { router.fetch(request).await })
        }),
        Some(MachineFactsOptions {
            cwd: config.cwd.clone(),
            omit_host_details,
            version: VERSION.into(),
        }),
        desktop,
        logger,
    )
    .await;
    let runtime = match runtime {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = router.close().await;
            let _ = store.close().await;
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
    let router_closed = router.close().await;
    let store_closed = store.close().await;
    Ok(if router_closed.and(store_closed).is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn desktop_from_environment(logger: &Logger) -> Option<Arc<DesktopService>> {
    let logger = logger.clone();
    desktop::desktop_from_environment(Arc::new(move |message: &str| {
        logger.warn(serde_json::json!({ "source": "desktop" }), message);
    }))
}

fn fail(message: &str) -> ExitCode {
    eprintln!("{BIN_NAME}: {message}");
    ExitCode::FAILURE
}

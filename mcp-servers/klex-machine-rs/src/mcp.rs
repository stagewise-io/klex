//! The klex-machine MCP server on rmcp: tool registry, per-request push
//! capability handling, and the Push Notifications get/ack methods.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex};

use futures::FutureExt;
use indexmap::IndexMap;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, CustomRequest, CustomResult,
    DiscoverResult, ErrorCode, InitializeRequestParams, InitializeResult, ListToolsResult,
    PaginatedRequestParams, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use tokio::sync::OnceCell;

use crate::filesystem::FilesystemService;
use crate::logger::Logger;
use crate::notifications::{
    NotificationStore, RecordKind, ShellExit, TrackedItem, shell_exited_event,
    watcher_completed_event,
};
use crate::paths::{MachinePathResolver, display};
use crate::push::{
    ACK_METHOD, GET_METHOD, MISSING_CAPABILITY_CODE, SubscriptionManager, has_push_capability,
    missing_capability_data, missing_capability_message,
};
use crate::search::SearchService;
use crate::shell::{self, ShellService};
use crate::watchers::{self, WatcherHooks, WatcherService};

const PROTOCOL_VERSION_META_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

static SERVER_CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../klex-machine/contract/server.json"))
        .expect("valid server contract")
});
static LOCAL_TOOLS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../klex-machine/contract/tools/local.json"))
        .expect("valid tool contract")
});
static PUSH_TOOLS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../klex-machine/contract/tools/push.json"))
        .expect("valid tool contract")
});

fn list_result(tools: &[Value]) -> ListToolsResult {
    serde_json::from_value(json!({ "tools": tools, "resultType": "complete" }))
        .expect("valid tool list")
}

static LOCAL_LIST: LazyLock<ListToolsResult> = LazyLock::new(|| list_result(&LOCAL_TOOLS));
static PUSH_LIST: LazyLock<ListToolsResult> = LazyLock::new(|| list_result(&PUSH_TOOLS));

pub struct MachineOptions {
    pub default_cwd: std::path::PathBuf,
    pub principal_id: String,
    pub store: Arc<NotificationStore>,
    pub owns_store: bool,
    pub logger: Logger,
    pub omit_host_details: bool,
}

pub struct Machine {
    principal_id: String,
    default_cwd: String,
    filesystem: FilesystemService,
    search: SearchService,
    shell: Arc<ShellService>,
    watchers: Arc<WatcherService>,
    store: Arc<NotificationStore>,
    owns_store: bool,
    shell_tracking: Arc<Mutex<HashSet<String>>>,
    subscriptions: Arc<SubscriptionManager>,
    unsubscribe: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    omit_host_details: bool,
    icons: OnceCell<Value>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

impl Machine {
    /// Must run inside a Tokio runtime: shell exits are reported from PTY threads.
    pub fn new(options: MachineOptions) -> Arc<Self> {
        let paths = MachinePathResolver::new(&options.default_cwd);
        let store = options.store;
        let principal_id = options.principal_id;
        let logger = options.logger;
        let shell_tracking: Arc<Mutex<HashSet<String>>> = Arc::default();

        let runtime = tokio::runtime::Handle::current();
        let on_exit: shell::ExitHook = {
            let store = store.clone();
            let tracking = shell_tracking.clone();
            let logger = logger.clone();
            Arc::new(move |info: shell::ShellInfo, output: String| {
                if !lock(&tracking).remove(&info.id) {
                    return;
                }
                let store = store.clone();
                let logger = logger.clone();
                runtime.spawn(async move {
                    let event = shell_exited_event(
                        &json!({ "sessionId": info.id, "shell": info.shell, "cwd": info.cwd, "createdAt": info.created_at }),
                        &ShellExit { exit_code: info.exit_code, signal: info.signal, exited_at: crate::time::iso_now(), output },
                    );
                    if let Err(error) = store.complete(&format!("shell:{}", info.id), event).await {
                        logger.error(json!({ "error": error.0 }), "Shell exit notification failed");
                    }
                });
            })
        };
        let shell = Arc::new(ShellService::new(
            paths.clone(),
            shell::MAX_SHELL_SESSIONS,
            Some(on_exit),
        ));

        let hooks = {
            let (start_store, finish_store, cancel_store) =
                (store.clone(), store.clone(), store.clone());
            let principal = principal_id.clone();
            let logger = logger.clone();
            WatcherHooks {
                on_start: Arc::new(move |info: Value| {
                    let store = start_store.clone();
                    let item = TrackedItem {
                        id: format!("watcher:{}", info["id"].as_str().unwrap_or_default()),
                        principal_id: principal.clone(),
                        kind: RecordKind::Watcher,
                        info,
                    };
                    async move { store.track(item).await.map_err(|error| error.0) }.boxed()
                }),
                on_finish: Arc::new(move |(info, completion)| {
                    let store = finish_store.clone();
                    async move {
                        let id = format!("watcher:{}", info["id"].as_str().unwrap_or_default());
                        store
                            .complete(&id, watcher_completed_event(&info, &completion))
                            .await
                            .map_err(|error| error.0)
                    }
                    .boxed()
                }),
                on_cancel: Arc::new(move |id: String| {
                    let store = cancel_store.clone();
                    async move {
                        store
                            .forget(&format!("watcher:{id}"))
                            .await
                            .map_err(|error| error.0)
                    }
                    .boxed()
                }),
                on_error: Arc::new(move |error: String| {
                    logger.error(json!({ "error": error }), "Watcher notification failed")
                }),
            }
        };
        let watchers = WatcherService::new(
            paths.clone(),
            hooks,
            watchers::MAX_WATCHERS,
            watchers::WATCHER_OUTPUT_DRAIN,
        );

        let subscriptions = SubscriptionManager::new();
        let unsubscribe = {
            let subscriptions = subscriptions.clone();
            let principal = principal_id.clone();
            store.on_event(
                &principal_id,
                Arc::new(move |event| subscriptions.publish(&principal, event)),
            )
        };

        Arc::new(Self {
            principal_id,
            default_cwd: display(&options.default_cwd),
            filesystem: FilesystemService::new(paths.clone()),
            search: SearchService::new(paths),
            shell,
            watchers,
            store,
            owns_store: options.owns_store,
            shell_tracking,
            subscriptions,
            unsubscribe: Mutex::new(Some(Box::new(unsubscribe))),
            omit_host_details: options.omit_host_details,
            icons: OnceCell::new(),
        })
    }

    pub fn subscriptions(&self) -> &Arc<SubscriptionManager> {
        &self.subscriptions
    }

    pub fn principal_id(&self) -> &str {
        &self.principal_id
    }

    /// Resolves the icons that feed `serverInfo`.
    pub async fn prepare_icons(&self) {
        self.icons
            .get_or_init(|| async {
                if self.omit_host_details {
                    crate::icons::machine_icons(None)
                } else {
                    crate::icons::detected_machine_icons().await
                }
            })
            .await;
    }

    fn instructions(&self, push: bool) -> String {
        let template = SERVER_CONTRACT["instructions"].as_str().unwrap_or_default();
        let mut instructions = template
            .replace("${cwd}", &self.default_cwd)
            .replace("${platform}", crate::platform::host::PLATFORM);
        if push {
            instructions.push_str(
                SERVER_CONTRACT["pushInstructionsSuffix"]
                    .as_str()
                    .unwrap_or_default(),
            );
        }
        instructions
    }

    fn server_info(&self, push: bool) -> ServerConfig {
        let icons = self
            .icons
            .get()
            .cloned()
            .unwrap_or_else(|| crate::icons::machine_icons(None));
        serde_json::from_value(json!({
            "protocolVersion": rmcp::model::ProtocolVersion::LATEST,
            "capabilities": SERVER_CONTRACT["capabilities"],
            "serverInfo": { "name": crate::SERVICE_NAME, "version": "0.1.0", "icons": icons },
            "instructions": self.instructions(push),
        }))
        .expect("valid server info")
    }

    pub async fn close(&self) {
        if let Some(unsubscribe) = lock(&self.unsubscribe).take() {
            unsubscribe();
        }
        self.subscriptions.close();
        tokio::join!(self.watchers.close_all(), self.shell.close_all());
        lock(&self.shell_tracking).clear();
        if self.owns_store {
            self.store.close().await;
        }
    }

    async fn blocking<T: DeserializeOwned + Send + 'static>(
        &self,
        args: Value,
        operation: impl FnOnce(T) -> Result<Value, String> + Send + 'static,
    ) -> Result<Value, String> {
        let input: T = serde_json::from_value(args).map_err(error_text)?;
        tokio::task::spawn_blocking(move || operation(input))
            .await
            .map_err(error_text)?
    }

    async fn execute(&self, name: &str, args: Value, push: bool) -> Result<Value, String> {
        let string = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
        let number = |key: &str| args.get(key).and_then(Value::as_f64);
        match name {
            "read" => {
                let filesystem = self.filesystem.clone();
                self.blocking(args, move |input| filesystem.read(input))
                    .await
            }
            "list" => {
                let filesystem = self.filesystem.clone();
                let path = string("path").unwrap_or_default();
                tokio::task::spawn_blocking(move || filesystem.list(&path))
                    .await
                    .map_err(error_text)?
            }
            "write" => {
                let filesystem = self.filesystem.clone();
                self.blocking(args, move |input| filesystem.write(input))
                    .await
            }
            "multiEdit" => {
                let filesystem = self.filesystem.clone();
                let path = string("path").unwrap_or_default();
                let edits = args.get("edits").cloned().unwrap_or_default();
                self.blocking(edits, move |edits| filesystem.multi_edit(&path, edits))
                    .await
            }
            "mkdir" | "delete" => {
                let filesystem = self.filesystem.clone();
                let path = string("path").unwrap_or_default();
                let delete = name == "delete";
                tokio::task::spawn_blocking(move || {
                    if delete {
                        filesystem.delete(&path)
                    } else {
                        filesystem.mkdir(&path)
                    }
                })
                .await
                .map_err(error_text)?
            }
            "copy" => {
                let filesystem = self.filesystem.clone();
                self.blocking(args, move |input| filesystem.copy(input))
                    .await
            }
            "glob" => {
                let search = self.search.clone();
                self.blocking(args, move |input| search.glob(input)).await
            }
            "grepSearch" => {
                let search = self.search.clone();
                self.blocking(args, move |input| search.grep(input)).await
            }
            "createShellSession" => {
                let env = args.get("env").and_then(Value::as_object).map(|env| {
                    env.iter()
                        .map(|(key, value)| {
                            (key.clone(), value.as_str().unwrap_or_default().to_string())
                        })
                        .collect::<IndexMap<_, _>>()
                });
                let options = shell::CreateOptions {
                    cwd: string("cwd"),
                    shell: string("shell"),
                    args: args.get("args").and_then(Value::as_array).map(|items| {
                        items
                            .iter()
                            .map(|item| item.as_str().unwrap_or_default().to_string())
                            .collect()
                    }),
                    cols: number("cols"),
                    rows: number("rows"),
                    env,
                };
                let notify =
                    push && args.get("notifyOnExit").and_then(Value::as_bool) == Some(true);
                if !notify {
                    return self.shell.create(options, None).map(|info| info.to_json());
                }
                let tracking = self.shell_tracking.clone();
                let cancel_tracking = self.shell_tracking.clone();
                let info = self
                    .shell
                    .create_tracked(
                        options,
                        |reservation| async move {
                            self.store
                                .track(TrackedItem {
                                    id: format!("shell:{}", reservation.id),
                                    principal_id: self.principal_id.clone(),
                                    kind: RecordKind::Shell,
                                    info: json!({
                                        "sessionId": reservation.id,
                                        "shell": reservation.shell,
                                        "cwd": reservation.cwd,
                                        "createdAt": reservation.created_at,
                                    }),
                                })
                                .await
                                .map_err(|error| error.0)?;
                            lock(&tracking).insert(reservation.id);
                            Ok(())
                        },
                        |id| async move {
                            lock(&cancel_tracking).remove(&id);
                            let _ = self.store.forget(&format!("shell:{id}")).await;
                        },
                    )
                    .await?;
                Ok(info.to_json())
            }
            "writeShellSession" => {
                self.shell.write(
                    &string("id").unwrap_or_default(),
                    &string("data").unwrap_or_default(),
                )?;
                Ok(Value::Null)
            }
            "readShellSession" => {
                self.shell
                    .read(shell::ReadOptions {
                        id: string("id").unwrap_or_default(),
                        cursor: number("cursor"),
                        wait_ms: number("waitMs"),
                    })
                    .await
            }
            "resizeShellSession" => {
                self.shell.resize(
                    &string("id").unwrap_or_default(),
                    number("cols").unwrap_or(0.0),
                    number("rows").unwrap_or(0.0),
                )?;
                Ok(Value::Null)
            }
            "closeShellSession" => {
                let id = string("id").unwrap_or_default();
                self.shell.close(&id)?;
                lock(&self.shell_tracking).remove(&id);
                self.store
                    .forget(&format!("shell:{id}"))
                    .await
                    .map_err(|error| error.0)?;
                Ok(Value::Null)
            }
            "listShellSessions" => Ok(Value::Array(
                self.shell
                    .list()
                    .iter()
                    .map(shell::ShellInfo::to_json)
                    .collect(),
            )),
            "createWatcher" => {
                let env = args.get("env").and_then(Value::as_object).map(|env| {
                    env.iter()
                        .map(|(key, value)| {
                            (key.clone(), value.as_str().unwrap_or_default().to_string())
                        })
                        .collect::<IndexMap<_, _>>()
                });
                self.watchers
                    .create(watchers::CreateOptions {
                        command: string("command").unwrap_or_default(),
                        title: string("title").unwrap_or_default(),
                        timeout_ms: number("timeoutMs").unwrap_or(0.0),
                        cwd: string("cwd"),
                        env,
                    })
                    .await
            }
            "listWatchers" => {
                let mut watchers = self.watchers.list();
                for record in self.store.records(&self.principal_id).await {
                    let (RecordKind::Watcher, Some(event)) = (record.item.kind, &record.event)
                    else {
                        continue;
                    };
                    let Value::Object(mut info) = record.item.info.clone() else {
                        continue;
                    };
                    let watcher_id = info.get("watcherId").cloned().unwrap_or(Value::Null);
                    info.insert("id".into(), watcher_id);
                    let lost = event.get("type").and_then(Value::as_str) == Some("watcher.lost");
                    info.insert(
                        "status".into(),
                        json!(if lost { "lost" } else { "completed" }),
                    );
                    if let Some(outcome) = event.get("data").and_then(|data| data.get("outcome")) {
                        info.insert("outcome".into(), outcome.clone());
                    } else {
                        info.shift_remove("outcome");
                    }
                    watchers.push(Value::Object(info));
                }
                Ok(Value::Array(watchers))
            }
            "cancelWatcher" => {
                let id = string("id").unwrap_or_default();
                let record_id = format!("watcher:{id}");
                if self.watchers.contains(&id) {
                    self.watchers.cancel(&id).await?;
                } else if self
                    .store
                    .records(&self.principal_id)
                    .await
                    .iter()
                    .any(|record| record.item.id == record_id)
                {
                    self.store
                        .forget(&record_id)
                        .await
                        .map_err(|error| error.0)?;
                } else {
                    return Err(format!("Unknown watcher: {id}"));
                }
                Ok(Value::Null)
            }
            _ => Err(format!("Tool {name} not found")),
        }
    }
}

fn tool_result(text: String, is_error: bool) -> CallToolResponse {
    let mut value =
        json!({ "content": [{ "type": "text", "text": text }], "resultType": "complete" });
    if is_error {
        value["isError"] = json!(true);
    }
    let result: CallToolResult = serde_json::from_value(value).expect("valid tool result");
    result.into()
}

fn request_has_push(context: &RequestContext<RoleServer>) -> bool {
    has_push_capability(Some(&context.meta.0))
}

fn params_error(method: &str, issues: String) -> McpError {
    McpError::new(
        ErrorCode::INVALID_PARAMS,
        format!("Invalid params for {method}: {issues}"),
        None,
    )
}

#[derive(Clone)]
pub struct MachineHandler {
    machine: Arc<Machine>,
}

impl MachineHandler {
    pub fn new(machine: Arc<Machine>) -> Self {
        Self { machine }
    }
}

impl ServerHandler for MachineHandler {
    fn get_info(&self) -> ServerConfig {
        self.machine.server_info(false)
    }

    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, McpError> {
        context.peer.set_peer_info(request.clone());
        let mut result = self.negotiate_initialize(&request)?;
        result.instructions = Some(self.machine.instructions(request_has_push(&context)));
        Ok(result)
    }

    async fn discover(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, McpError> {
        Ok(DiscoverResult::from_server_info(
            self.supported_protocol_versions().into_owned(),
            self.machine.server_info(request_has_push(&context)),
        ))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(if request_has_push(&context) {
            PUSH_LIST.clone()
        } else {
            LOCAL_LIST.clone()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let push = request_has_push(&context);
        let tools: &[Value] = if push { &PUSH_TOOLS } else { &LOCAL_TOOLS };
        let name = request.name.to_string();
        let Some(tool) = tools.iter().find(|tool| tool["name"] == name.as_str()) else {
            return Err(McpError::new(
                ErrorCode::INVALID_PARAMS,
                format!("Tool {name} not found"),
                None,
            ));
        };
        let args = Value::Object(request.arguments.unwrap_or_default());
        let args = match crate::schema::validate(&tool["inputSchema"], &args) {
            Ok(args) => args,
            Err(issues) => {
                return Ok(tool_result(
                    format!("Input validation error: Invalid arguments for tool {name}: {issues}"),
                    true,
                ));
            }
        };
        Ok(match self.machine.execute(&name, args, push).await {
            Ok(Value::Null) => tool_result(json!({ "ok": true }).to_string(), false),
            Ok(value) => tool_result(value.to_string(), false),
            Err(message) => tool_result(format!("Error: {message}"), true),
        })
    }

    async fn on_custom_request(
        &self,
        request: CustomRequest,
        context: RequestContext<RoleServer>,
    ) -> Result<CustomResult, McpError> {
        let method = request.method.as_str();
        if method != GET_METHOD && method != ACK_METHOD {
            return Err(McpError::new(
                ErrorCode::METHOD_NOT_FOUND,
                "Method not found",
                None,
            ));
        }
        let params = request.params.unwrap_or_else(|| Value::Object(Map::new()));
        let schema = if method == GET_METHOD {
            json!({
                "type": "object",
                "additionalProperties": true,
                "properties": { "limit": { "type": "integer", "exclusiveMinimum": 0, "maximum": MAX_SAFE_INTEGER } },
            })
        } else {
            json!({
                "type": "object",
                "additionalProperties": true,
                "properties": { "eventIds": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } } },
                "required": ["eventIds"],
            })
        };
        let params =
            validate_params(&schema, &params).map_err(|issues| params_error(method, issues))?;
        if !request_has_push(&context) {
            return Err(McpError::new(
                ErrorCode(MISSING_CAPABILITY_CODE),
                missing_capability_message(),
                Some(missing_capability_data()),
            ));
        }
        let machine = &self.machine;
        let mut result = if method == GET_METHOD {
            let limit = params.get("limit").and_then(Value::as_f64);
            machine
                .store
                .pending(&machine.principal_id, limit)
                .await
                .map_err(|error| McpError::internal_error(error.0, None))?
        } else {
            let event_ids: Vec<String> = params["eventIds"]
                .as_array()
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            machine
                .store
                .acknowledge(&machine.principal_id, &event_ids)
                .await
                .map_err(|error| McpError::internal_error(error.0, None))?;
            json!({})
        };
        if context.meta.contains_key(PROTOCOL_VERSION_META_KEY) {
            result["resultType"] = json!("complete");
        }
        Ok(CustomResult::new(result))
    }
}

/// `record & object` params: unknown keys are kept, declared ones validated.
fn validate_params(schema: &Value, params: &Value) -> Result<Value, String> {
    let Value::Object(object) = params else {
        let kind = match params {
            Value::Null => "null",
            Value::Array(_) => "array",
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Bool(_) => "boolean",
            Value::Object(_) => "object",
        };
        return Err(format!("Invalid input: expected record, received {kind}"));
    };
    let mut declared = schema.clone();
    if let Some(declared) = declared.as_object_mut() {
        declared.remove("additionalProperties");
    }
    crate::schema::validate(&declared, params)?;
    Ok(Value::Object(object.clone()))
}

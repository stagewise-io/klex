# Model provider registry

The provider registry is the single integration point for language-model transports in Klex. A provider **type** defines metadata, setup fields, validation, lifecycle hooks, model discovery, connectivity testing, and runtime model creation. A configured provider **instance** supplies a stable `providerId`, a type, settings, and optional manual model metadata. Multiple instances can use the same type.

## Supported provider types

| Type | Service or protocol | Automatic discovery |
| --- | --- | --- |
| `openai` | OpenAI | Yes |
| `anthropic` | Anthropic | Yes |
| `google-gemini` | Google Gemini API | Yes |
| `google-vertex` | Google Vertex AI | No |
| `amazon-bedrock` | Amazon Bedrock | No |
| `azure-openai` | Microsoft Azure OpenAI | No |
| `openrouter` | OpenRouter | Yes |
| `moonshot` | Moonshot AI | OpenAI-compatible discovery |
| `alibaba-qwen` | Alibaba Qwen | OpenAI-compatible discovery |
| `deepseek` | DeepSeek | OpenAI-compatible discovery |
| `zai` | Z.ai / GLM | OpenAI-compatible discovery |
| `minimax` | MiniMax | OpenAI-compatible discovery |
| `xiaomi-mimo` | Xiaomi MiMo | OpenAI-compatible discovery |
| `mistral` | Mistral AI | OpenAI-compatible discovery |
| `xai` | xAI | OpenAI-compatible discovery |
| `glm-coding-plan` | GLM Coding Plan | OpenAI-compatible discovery |
| `minimax-coding-plan` | MiniMax Coding Plan | OpenAI-compatible discovery |
| `opencode-go` | OpenCode Go API plan | OpenAI-compatible discovery |
| `opencode-zen` | OpenCode Zen API plan | OpenAI-compatible discovery |
| `chatgpt-codex-subscription` | ChatGPT Codex Subscription model transport | No |
| `chat-completions` | Custom OpenAI Chat Completions endpoint | No |
| `responses` | Custom OpenAI Responses endpoint | No |
| `anthropic-messages` | Custom Anthropic Messages endpoint | No |
| `google-generative` | Custom Google Generative AI endpoint | No |
| `ollama` | Local Ollama daemon | Yes |

This registry covers language-model transports only. Full Codex, Claude Code, and OpenCode agent runtimes are outside Klex's provider abstraction: Klex does not adopt their tool loop, process lifecycle, memory, or agent behavior. The ChatGPT Codex Subscription and OpenCode Go/Zen entries above remain supported because they expose model transports to Klex's own agent runtime.

## Lifecycle semantics

Every provider definition exposes user-facing metadata (`name`, `description`, optional SVG logo, capabilities, setup fields, and usage guidance) and implements the shared provider contract.

- **Preflight:** `preflightCreate`, `preflightUpdate`, and `preflightRemove` validate prerequisites without mutating configuration. Failures use stable codes and may include remediation text.
- **Setup:** optional setup hooks run after preflight and before persistence. They may resolve local dependencies or normalize settings. Cleanup hooks run as part of removal. A failed hook leaves configuration unchanged.
- **Discovery:** `discoverModels` returns transient model metadata. Discovery never rewrites configuration. Manual `knownModels` entries are merged by exact model ID and take precedence field by field.
- **Connectivity:** `testConnection` returns a structured success or failure result. Tests use the configured credentials and an optional provider-specific test model; they do not persist discovered models.
- **Resolution:** runtime selection always uses the pair `{ providerId, modelId }`. Model IDs are opaque and may contain colons.

## Admin API contract

The Admin API exposes enough metadata to build provider-neutral setup interfaces:

- `GET /v1/provider-types` lists registry types, metadata, capabilities, and declarative setup fields.
- `POST /v1/provider-types/{type}/can-add` runs create preflight for candidate settings.
- `GET /v1/providers` lists configured instances with their type and redacted settings.
- `POST /v1/providers` creates an instance.
- `PATCH /v1/providers/{id}` updates an instance.
- `DELETE /v1/providers/{id}` removes an instance after referential-integrity and lifecycle checks.
- `POST /v1/providers/{id}/test` runs the standardized connectivity test.
- `GET /v1/providers/{id}/models` returns merged manual and discovered models; callers can control discovery through the query contract.
- `POST /v1/providers/{id}/models`, `PATCH /v1/providers/{id}/models/{modelId}`, and `DELETE /v1/providers/{id}/models/{modelId}` manage manual model metadata.

Operation failures return a machine-readable `code`, a human-readable `error`, and optional `remediation`. Expected categories include invalid configuration, missing dependencies, authentication, unsupported platforms, connectivity, discovery, conflict, referential integrity, and internal errors. API clients must branch on `code`, not parse the message.

## Secrets

Setup fields marked `secret` identify credentials, but this is a UI hint rather than storage encryption. Persist environment placeholders such as `${env:OPENAI_API_KEY}` instead of literal credentials. Interpolation occurs only in the runtime configuration view. Admin API serialization, logs, telemetry, migration, and later writes must retain placeholders or redact resolved credentials; they must never return resolved secret values.

## Version 1 migration

The configuration module performs a one-time, atomic v1-to-v2 migration. Preset providers become typed instances. Manual endpoints become individual protocol-adapter instances. All model selections become explicit `{ providerId, modelId }` references. Model IDs, provider options, voice selections, known-model capabilities, and environment references are preserved. Collisions, unresolved environment variables, and unsupported non-language-model endpoints fail the complete migration without partially rewriting the source file.

See `../config/README.md` for the schema, examples, interpolation syntax, and exact instance-ID rules.

## Adding a provider

A built-in provider should require one registry definition, not changes throughout the Admin API or CLI:

1. Add one provider file under `providers/` and register its exported definition in `providers/providers.ts`. Use the shared spec factory when an existing transport adapter is sufficient; implement a focused `ProviderDefinition` only when provider-specific behavior cannot be expressed by the shared factory.
2. Supply complete metadata and declarative setup fields. Mark credentials as `secret`; use conditions for fields tied to an authentication mode.
3. Implement or select settings validation, create/update/remove preflight, optional setup/cleanup, discovery, connectivity testing, and runtime factory behavior.
4. Add contract tests for invalid settings, blocked prerequisites, lifecycle atomicity, discovery/manual merge behavior, connectivity results, and runtime resolution.
5. Verify that the generic Admin API and CLI render and operate the new definition. Do not add provider-specific routes or screens unless the shared contract cannot represent a necessary capability.

`createProviderRegistry()` validates definitions at startup and rejects duplicate types or incomplete metadata. Do not weaken that validation to accommodate a new provider; complete the definition instead.

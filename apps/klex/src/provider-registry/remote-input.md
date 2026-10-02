# Remote media input

`readAttachment({ url, mediaType })` supplies a remote file to the next ordinary
generation. The caller must obtain the media type from trustworthy source
metadata. Missing types, filename guesses, invalid URLs, credentials in URLs,
and unsupported media return `Remote media unavailable or unsupported.` No
request is made to discover a type or inspect bytes.

The model's AI SDK v4 `supportedUrls` declaration is the extensible remote-input
capability contract. Its MIME patterns and URL patterns are checked together.
Existing Klex image/audio capabilities additionally gate those families and
their declared subtypes. Other MIME types use the SDK declaration, which can be
model-specific (for example Gemini 2.0 versus later Gemini models). The existing
config schema has no extensible file/video metadata; this change adds no
persisted config fields, store, or migration.

The native mappings below follow the installed SDK adapters. Tests capture the
actual outgoing bodies, in streaming and non-streaming generation.

| Adapter | Declared HTTP remote input | Native mapping |
| --- | --- | --- |
| OpenAI, Azure OpenAI | Images, PDF | Responses `input_image.image_url` or `input_file.file_url` in tool output |
| Responses API, ChatGPT Codex subscription | Images | Open Responses `input_image.image_url` in tool output; its SDK does not declare remote PDF support |
| Anthropic, Anthropic Messages | Images, PDF | Tool result `image` or `document`, with URL source |
| Google Gemini, Google Generative | Model-specific MIME and URL patterns, including PDF, video and text on supported models | `fileData` with `mimeType` and `fileUri` |
| Google Vertex | SDK wildcard HTTP URL declaration, with Klex image/audio gates | `fileData` with `mimeType` and `fileUri` |
| Amazon Bedrock | No HTTP URL support (SDK declares S3 only) | Unavailable |
| OpenAI-compatible adapters | No remote URL declaration in current configuration | Unavailable |

The compatible group includes OpenRouter, Moonshot, Alibaba Qwen, DeepSeek, ZAI,
MiniMax, Xiaomi MiMo, Mistral, xAI, GLM Coding Plan, MiniMax Coding Plan, OpenCode
Go/Zen, Chat Completions, and Ollama. Provider availability alone does not imply
that the configured adapter can carry native remote media.

Canonical tool output contains a JSON-safe structured file block. The extension
reconstructs an AI SDK URL object when preparing the next generation and checks
the current selected model again, so model switching cannot cause an SDK download.
Google's SDK only accepts inline bytes in function responses; the provider
wrapper moves remote tool files to adjacent native user content while retaining
the paired tool result. Other supported adapters map tool files directly.

Only the later generation contacts the provider. Provider rejections and
transport errors follow normal generation classification; diagnostic reasons
omit URLs and provider messages. Raw URLs remain in private tool content, debug
logs, compressed history/episode JSONL, and configured telemetry content recording
under the accepted policy. There is no separate inference call, download,
decoding, cache, attachment store, or media fallback.

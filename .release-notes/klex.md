### Fix existing config startup

Fixes the startup failure introduced in 0.27.0 when loading existing configs. Supports both legacy schema-6 configs and STS-only configs written by 0.27.0. The migration removes obsolete TTS/STT model selections while preserving STS voices, provider options, audio-listening selections, providers, and instinct settings.

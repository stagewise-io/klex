# Content adaptation

Canonical UI history remains unchanged. The main session converts a fresh
projection for each model attempt, then the audio optimizer delegates audio
processing to `adaptAudioContent`. The extension owns `listenAudio` registration,
IDs, interactive hints, and stripping calls when the tool is unavailable.

The adapter uses the existing audio processing and description caches. Native
audio is optimized for the target's formats, byte limits, and duration limits.
Text-only targets receive explicitly marked derived transcription/description
text. Audio helper fallback optimizes the original separately for every candidate.
Remote audio remains on-demand in the interactive extension; compaction requests
its description directly.

Compaction retains the safe line-format transcript and adds separately labeled
media from materialized UI messages (including inline context and tool media).
Each configured compaction candidate, then each chat fallback, receives its own
adaptation of the original media. Text-only histories keep the existing batched
fallback call. If audio or images cannot be optimized or described, that candidate is
skipped; if all candidates fail, no checkpoint is committed. This preserves the
unsummarized history for a later attempt.

Image attachments reuse the image helper and optimization pipeline, adapting the
original separately for each helper candidate. Other file
types retain safe attachment notes; adding their native/helper adaptation belongs
in this layer. Media payloads and attachment URLs travel only in media parts,
never in generated transcript placeholders. Filenames are omitted because they
can contain URLs or secrets. Compaction defers when its only possible anchors
would discard the first raw active user input, including after a checkpoint.
No persistent schema changes are
needed: derived content exists only in inference projections.

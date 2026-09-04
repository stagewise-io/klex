# Klex release notes

Stable changelog entries are generated from conventional commits scoped to
`klex`. To add operator-facing context that commit subjects do not capture,
create `.release-notes/klex.md` before dispatching **Prepare Klex Release**.

Its Markdown is inserted immediately below the new version heading, before the
generated commit groups. The generated release PR deletes `klex.md`, so the
text applies to one stable release only. Do not put secrets, temporary CI data,
or nightly notes here.

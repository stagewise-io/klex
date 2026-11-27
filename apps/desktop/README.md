# Klex Desktop

Tray app that connects a Windows, macOS, or Linux computer to Klex Cloud. The
user pastes an enrollment code (or opens a `klex://pair?code=XXXX-XXXX-XXXX`
link), confirms the organization and machine name Cloud reports, and the app
keeps the machine connected in the background.

## How it works

The app is a Tauri v2 shell around the Rust `klex-machine` crate
(`mcp-servers/klex-machine-rs`). It runs the machine itself in a child process:
the app re-executes its own binary with `--daemon` followed by normal
`klex-machine` arguments, so one executable ships both.

- Pairing calls `POST /api/machines/enrollment-preview` in-process, shows the
  consent step, and only then runs `--daemon cloud enroll --code-stdin
  --no-serve --supervised`. The code goes over stdin and never appears in argv.
- Connected, the app supervises `--daemon serve --mode enrolled --supervised`
  and restarts it with backoff if it exits.
- `--supervised` makes the daemon write newline-delimited JSON status events to
  stdout (`hello`, `enrolled`, `state`, `error`; see
  `mcp-servers/klex-machine-rs/src/supervised.rs`). It reads commands from
  stdin and shuts down on `{"type":"shutdown"}` or when stdin closes, so the
  daemon never outlives the app. Its stderr goes to the app's logs.

The machine identity lives in the app's local data directory under `machine/`.
Settings (connect on start, organization name) live in the config directory.
Logs are kept in memory for the Logs tab and in `klex-desktop.log` in the app
log directory.

## Development

On Linux, install Tauri's system libraries first:

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libgtk-3-dev libsoup-3.0-dev
```

Then, from the repository root:

```sh
pnpm install
pnpm --filter @klex/desktop desktop:dev    # app with Vite HMR
pnpm --filter @klex/desktop desktop:build  # unsigned debug bundles in target/debug/bundle
```

`KLEX_DESKTOP_CLOUD_URL` points pairing at another Cloud, for example a local
stack. The daemon trusts extra CAs from `NODE_EXTRA_CA_CERTS`.

The product name and identifier (`bot.klex.desktop`) are set in
`src-tauri/tauri.conf.json`.

## Releases

Klex Desktop is versioned and released separately from klex, as GitHub
Releases tagged `desktop-v<version>` in this repository. They never take the
repository's Latest badge.

- **Stable:** add a `## <version>` section to `CHANGELOG.md` and bump
  `version` in `package.json` in one pull request. Merging it runs
  `.github/workflows/release-klex-desktop.yml`.
- **Nightly:** `.github/workflows/nightly-klex-desktop.yml` runs daily at
  02:47 UTC when the app, `klex-machine-rs` or the Cargo files changed since
  the last nightly. Versions are `<next patch>-nightly.<YYYYMMDD>.<n>`.

Both call `.github/workflows/_release-klex-desktop.yml`. It builds macOS
(arm64, x64), Windows (x64) and Linux (x64, arm64: AppImage and .deb) on
native runners. It signs and notarizes with the `Release` environment's Apple
and Azure Artifact Signing secrets, then installs and checks each build on
its platform before publishing anything.

Release builds add `plugins.updater` through a generated config overlay
(`scripts/release/release-config.ts`); development and CI builds have no
updater. The app checks the channel's `latest.json`, which lives on the
rolling `desktop-channel-stable` or `desktop-channel-nightly` release. It
downloads updates in the background and installs them when the person picks
"Restart to update". Nightly installs also receive each newer stable release.

Updates are signed with the key in the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. Its public half is
`src-tauri/updater.pub`, and the release refuses artifacts that don't verify
against it. Installed apps trust only this key, so losing it ends automatic
updates.

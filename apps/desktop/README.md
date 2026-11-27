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

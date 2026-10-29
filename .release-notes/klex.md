### Action required if you installed 0.27.0

**Please update manually to 0.27.1, even if you already updated to 0.27.0.** Version 0.27.0 can fail during startup when loading an existing config. Affected bots cannot reach the automatic updater, so waiting for an automatic update will not recover them.

After 0.27.1 is published:

1. Stop the affected Klex process or service. Back up its existing agent data directory.
2. Re-run the installer under the same account and with the same installation directory you used originally. On macOS and Linux:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/stagewise-io/klex/main/install.sh | sh -s -- --version 0.27.1
   ```

   On Windows, run the PowerShell installer with the version pinned:

   ```powershell
   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/stagewise-io/klex/main/install.ps1))) -Version 0.27.1
   ```

   If you installed Klex another way, replace its binary with the 0.27.1 release for your platform. For containers, deploy the 0.27.1 image using your existing deployment configuration and persistent data volume.
3. Verify `klex --version` reports `0.27.1`, or verify the binary/image used by your service directly. Restart the bot with its existing agent data directory.

**Do not delete your config or agent data, create a replacement agent, or edit `_klex` metadata to bypass the error.** The fixed binary migrates the existing config automatically. It preserves STS voices, provider options, audio-listening selections, providers, and instinct settings while removing the obsolete TTS/STT model selections.

This release restores support for existing schema-6 configs and for STS-only configs written by 0.27.0. Migration advances the config to schema 7. After that migration, older binaries will refuse to open the config; reinstalling an older binary is not a supported rollback.

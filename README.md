<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/wordmark-dark.png">
  <img src="assets/brand/wordmark.png" alt="Klex" width="240">
</picture>

An isolated agent that excels at memory, self-improvement, and efficient orchestration.

## Installation

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/stagewise-io/klex/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/stagewise-io/klex/main/install.ps1 | iex
```

The default installer resolves the dedicated `channel-stable` manifest; nightly
and exact-version installs use their own release URLs. It verifies the archive's
SHA-256 and installs into a versioned directory behind a `current` link, so
upgrades never overwrite a running install. It then runs `klex --verify-native` to prove the
native runtime dependencies actually load on your machine. It never uses `sudo`
and writes nothing outside your home directory.

Supported: macOS on Apple Silicon and Intel, glibc-based Linux on ARM64 and x64,
Windows on x64. Windows ARM64 gets the x64 build under emulation. musl-based
Linux (Alpine) is not supported and is detected rather than half-installed.

### Options

| macOS and Linux | Windows | Meaning |
|---|---|---|
| `--version <x.y.z>` | `-Version <x.y.z>` | Install an exact version instead of the newest release. Also settable as `KLEX_VERSION` |
| `--install-dir <path>` | `-InstallDir <path>` | Install root. Default: `${XDG_DATA_HOME:-~/.local/share}/klex`, or `%LOCALAPPDATA%\Klex`. Also settable as `KLEX_INSTALL_DIR` |
| `--no-modify-path` | `-NoModifyPath` | Leave shell startup files and the user `PATH` untouched |
| `--uninstall` | `-Uninstall` | Remove the installation |
| `KLEX_HOME` | `KLEX_HOME` | Agent data root. Default: `~/.klex` |

A piped script receives no arguments, so options have to be handed to the shell
itself. `KLEX_VERSION=... curl ...` sets the variable for `curl`, not for the
installer:

```bash
curl -fsSL https://raw.githubusercontent.com/stagewise-io/klex/main/install.sh | sh -s -- --version 0.1.1
```

The Windows script takes PowerShell-style parameters, and a piped script cannot
take parameters at all, so pass them through a script block:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/stagewise-io/klex/main/install.ps1))) -NoModifyPath
```

### Uninstalling

```bash
curl -fsSL https://raw.githubusercontent.com/stagewise-io/klex/main/install.sh | sh -s -- --uninstall
```

Uninstalling removes the program and its `PATH` entry. It deliberately leaves
`KLEX_HOME` (`~/.klex` by default) in place, because that directory holds your
configuration, credentials, enrollment state, and history. Delete it yourself if
you want it gone.

### Manual installation

Download the archive for your operating system and architecture from
[GitHub Releases](../../releases), verify it against the published checksum, and
extract the complete directory. Klex ships as a relocatable directory because
its executable loads native runtime dependencies from a sibling `node_modules`;
copying only the executable out of it will not work.

```bash
./klex --help
```

```powershell
.\klex.exe --help
```

Release operators should see [apps/klex/RELEASING.md](apps/klex/RELEASING.md).


## Klex is computer-agnostic

By default, Klex only has access to one dedicated, isolated `data-directory` on the machine it's running on. Every other connection to outside environments and machines is established via MCP and an MCP-Extension:

- Talking to you via Telegram, Discord or Slack
- Research on the Internet using Web-Search
- Orchestrating Claude Code agents on another remote VM 
- Updating an Excel-Sheet on your Laptop
- ...

This allows interoperability between various environments, machines and tools you're working with that do not run on the same machine as Klex. Connecting your local Chrome Browser to a remote Klex is just a few clicks; Provisioning a fresh Windows VM to let Klex run platform-specific code can be done in a minute without redeployment; Or letting Klex fix your remote dev server is possible without spawning the Klex on the same machine.


## Klex is self-improving:
After every task, Klex will reflect on its actions - and update its internal understanding and memory to do the task more efficiently the next time.


## Klex is sessionless:
There is no dedicated policy that determines which session an incoming message belongs to - every message is sent into the brain of Klex, where an agentic router decides what to do with the message:
- Delegate to a sub-agent with a smaller/faster model
- Queue the message into an existing conversation
- Provide an immediate quick response without delegating


### Klex is model-aware:
Klex knows about its available models and their tradeoffs:
- Just need to query some info -> Klex will use a flashy model to reduce latency
- Need to do market research -> Klex will use smart, available models to improve accuracy

## License

Klex is licensed under the [Apache License 2.0](LICENSE).

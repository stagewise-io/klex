# Windows-MCP Packaging Spike

This directory freezes Windows-MCP into a portable Windows x64 application. The target machine does not need Python, `uv`, or `uvx`.

## Scope

The spike pins:

- Windows-MCP 0.8.2 from PyPI
- CPython 3.13 x64
- PyInstaller 6.21.0
- pip-licenses 5.5.5
- uv 0.11.33

The complete Python resolution is committed in `uv.lock`. The artifact uses PyInstaller one-directory mode. That produces `windows-mcp.exe` plus an adjacent `_internal` directory. It is intentionally more diagnosable and less sensitive to temporary extraction and antivirus behavior than one-file mode.

This artifact contains only Windows-MCP. It does not contain the Stagewise Windows Use host, gateway connection, credentials, installer, or updater. The release workflow signs `windows-mcp.exe` with Azure Trusted Signing; local builds remain unsigned unless signing is configured.

## Build with GitHub Actions

Run the manually dispatched `Build Windows-MCP` workflow. The workflow:

1. Builds on Windows x64 with Python 3.13 and uv 0.11.33.
2. verifies that `uv.lock` is current;
3. freezes and signs Windows-MCP;
4. starts the signed executable in stateless Streamable HTTP mode;
5. verifies its `/mcp` endpoint and process-tree cleanup;
6. assembles the complete Windows Use bundle and verifies both final Authenticode signatures; and
7. uploads the complete portable ZIP for 14 days.

The action uses no gateway credentials and publishes no artifact when signing, signature verification, or the smoke test fails. Azure signing credentials are supplied only by the protected GitHub Environment and are never stored in the repository.

## Local Windows build

Local builds require 64-bit Windows, Python 3.13, and exactly uv 0.11.33. From PowerShell:

```powershell
cd mcp-servers/windows-use/packaging/windows-mcp
.\build.ps1
.\smoke-test.ps1 -BundleDirectory .\artifacts\windows-mcp-0.8.2-win-x64
```

The ZIP is written under `artifacts/`. Build outputs, virtual environments, and artifacts are ignored by Git. Without the Azure signing environment variables, this local build is intentionally unsigned.

## Package contents

The ZIP contains:

- `windows-mcp.exe` and its `_internal` runtime files;
- the upstream Windows-MCP MIT license;
- a generated third-party dependency and license report;
- a build manifest with versions, commit, lock hash, and executable hash; and
- clean-machine test instructions.

## Design notes

`windows_mcp_entry.py` calls `windows_mcp.__main__.main`, matching the upstream console-script entry point. The PyInstaller specification explicitly collects Windows-MCP and runtime-selected modules used by FastMCP, COM automation, DX capture, pywin32, Pillow, and native Levenshtein bindings.

Packaging success proves that the server starts without an external Python runtime. It does not prove every UI Automation, screenshot, GPU capture, or input backend works on the accountant's machine. Follow `TESTING.md` on the clean target machine before integrating this executable into the Node host.

# Test the Frozen Windows-MCP Artifact

Use these steps in an interactive Windows 11 x64 user session. The target machine should not have Python, `uv`, or `uvx` available on `PATH`; the purpose of this spike is to prove that none are runtime prerequisites.

## Obtain the artifact

1. Open the repository's GitHub Actions page.
2. Select `Build Windows Use` and run the workflow from the intended release branch.
3. Wait for signing, signature verification, and the smoke test to pass.
4. Download the `stagewise-windows-use-win-x64` artifact.
5. Extract the ZIP to a normal writable folder. Do not run it from inside the ZIP.

Release workflow artifacts are Authenticode-signed with Azure Trusted Signing. Before execution, verify both primary binaries from the complete Windows Use bundle:

```powershell
Get-AuthenticodeSignature .\stagewise-windows-use.exe
Get-AuthenticodeSignature .\windows-mcp\windows-mcp.exe
```

Both commands must report `Status: Valid`. A locally produced build may be unsigned when Azure signing configuration is absent. Do not disable Smart App Control or endpoint protection to run an unsigned local build.

## Start the server

Open PowerShell in the extracted bundle's `windows-mcp` directory and run:

```powershell
.\windows-mcp.exe serve `
  --transport streamable-http `
  --stateless-http `
  --host 127.0.0.1 `
  --port 8123
```

Do not insert `windows-mcp` before `serve`; that prefix is needed by `uvx`, not by the direct executable.

In a second PowerShell window, request the MCP endpoint:

```powershell
curl.exe -i http://127.0.0.1:8123/mcp
```

Any HTTP response proves local readiness. A non-2xx response to a bare GET is acceptable because a complete MCP request requires protocol headers and a body.

## Exercise native functionality

Use an MCP client or the later Windows Use integration to exercise representative tools:

1. Capture a snapshot or screenshot.
2. Open or focus a harmless application such as Notepad.
3. Read visible UI elements.
4. Perform one harmless click.
5. Enter and remove test text.

Startup alone does not exercise dynamically loaded COM, UI Automation, graphics, image, and input modules. Preserve the complete traceback and console output if any tool fails.

## Stop and verify cleanup

Press `Ctrl+C` in the server window. Then confirm that nothing is listening on port 8123:

```powershell
netstat -ano | findstr :8123
```

No `LISTENING` entry should remain. Start the server again with the same command to verify immediate restart, then stop it again with `Ctrl+C`.

## Record results

Record:

- Windows edition, version, and x64 architecture;
- whether Python, `uv`, and `uvx` were absent from `PATH`;
- ZIP and extracted sizes;
- startup time until the endpoint responds;
- SmartScreen and Defender behavior;
- results of each native-function test;
- any missing-module traceback or DLL load failure;
- shutdown and immediate-restart results; and
- the contents of `BUILD-MANIFEST.json`.

A valid signature proves publisher identity and artifact integrity; it does not make this portable test bundle an installer or production distribution. Installer behavior, broad OS support, enrollment, updating, and production credential handling remain later milestones.

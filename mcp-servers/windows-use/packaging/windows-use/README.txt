Stagewise Windows Use — portable test bundle

1. Verify both executable signatures in PowerShell:
   Get-AuthenticodeSignature .\stagewise-windows-use.exe
   Get-AuthenticodeSignature .\windows-mcp\windows-mcp.exe
   Both release-workflow binaries must report Status: Valid.
2. Edit windows-use.config.json.
3. Set gatewayUrl to the gateway environment WebSocket endpoint.
4. Set gatewayToken to this machine's environment token.
5. Double-click stagewise-windows-use.exe.
6. Keep the console open while the computer is connected.
7. Press Ctrl+C or close the console to disconnect and stop Windows-MCP.

Do not share or commit the configured token.
Local builds may be unsigned when Azure signing configuration is absent.

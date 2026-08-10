from pathlib import Path

from PyInstaller.utils.hooks import collect_all, copy_metadata


project_directory = Path(SPEC).resolve().parent

datas = []
binaries = []
hidden_imports = [
    "pythoncom",
    "pywintypes",
    "win32api",
    "win32clipboard",
    "win32com.client",
    "win32con",
    "win32gui",
    "win32process",
]

# The MCP CLI is an optional extra and exits during import when its optional
# Typer dependency is absent. The frozen server uses the MCP runtime only.
def include_runtime_module(module_name):
    return module_name != "mcp.cli" and not module_name.startswith("mcp.cli.")


# Windows-MCP, FastMCP, COM automation, screen capture, and native text
# matching all contain runtime-selected modules or package data that static
# import analysis cannot reliably discover.
for package in (
    "windows_mcp",
    "fastmcp",
    "mcp",
    "comtypes",
    "dxcam",
    "Levenshtein",
):
    package_datas, package_binaries, package_imports = collect_all(
        package,
        filter_submodules=include_runtime_module,
    )
    datas += package_datas
    binaries += package_binaries
    hidden_imports += package_imports

# Runtime version checks use importlib.metadata rather than importing modules.
for distribution in (
    "windows-mcp",
    "fastmcp",
    "fastmcp-slim",
    "mcp",
):
    datas += copy_metadata(distribution)

analysis = Analysis(
    [str(project_directory / "windows_mcp_entry.py")],
    pathex=[str(project_directory)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="windows-mcp",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
)

bundle = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="windows-mcp",
)

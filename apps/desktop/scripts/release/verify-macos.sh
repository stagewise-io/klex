#!/usr/bin/env bash
# Checks a Klex Desktop disk image: the app inside has the expected version
# and its daemon entry point runs. With --signed, also requires a valid
# Developer ID signature, Gatekeeper approval and stapled notarization on the
# disk image, the app and the updater archive. CI runs it unsigned on debug
# bundles; the release workflow runs it with --signed.
#
# Usage: verify-macos.sh [--signed] <dmg> <version> [<updater .app.tar.gz>]
set -euo pipefail

signed=false
if [[ "${1:-}" == --signed ]]; then
  signed=true
  shift
fi
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 [--signed] <dmg> <version> [<updater .app.tar.gz>]" >&2
  exit 2
fi
dmg="$1"
version="$2"
update="${3:-}"

assert_version() {
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist")" = "$version"
}

if [[ "$signed" == true ]]; then
  codesign --verify --strict --verbose=2 "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
  xcrun stapler validate "$dmg"
fi

mount="$(mktemp -d)"
hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg"
trap 'hdiutil detach "$mount" -force >/dev/null || true' EXIT
app="$mount/Klex Desktop.app"
if [[ "$signed" == true ]]; then
  codesign --verify --deep --strict --verbose=2 "$app"
  spctl --assess --type execute --verbose=2 "$app"
  xcrun stapler validate "$app"
fi
assert_version "$app"
"$app/Contents/MacOS/klex-desktop" --daemon --version

if [[ -n "$update" ]]; then
  extracted="$(mktemp -d)"
  tar -xzf "$update" -C "$extracted"
  if [[ "$signed" == true ]]; then
    codesign --verify --deep --strict --verbose=2 "$extracted/Klex Desktop.app"
    xcrun stapler validate "$extracted/Klex Desktop.app"
  fi
  assert_version "$extracted/Klex Desktop.app"
fi

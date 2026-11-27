#!/usr/bin/env bash
# Points a desktop-channel-* release at a verified latest.json. The pointer
# carries exactly one asset, latest.json; binaries stay on the immutable
# versioned release its URLs reference. A pointer never moves back to an
# older version, so a slower run can't undo a newer one.
#
# Usage: update-pointer.sh <pointer-tag> <latest.json> <title>
# Needs GH_TOKEN, REPO and COMMIT; run from the repository root.
set -euo pipefail

pointer="$1"
manifest="$2"
title="$3"
version="$(jq -r .version "$manifest")"
semver=apps/desktop/scripts/release/semver.ts

if gh release view "$pointer" --repo "$REPO" >/dev/null 2>&1; then
  previous="$(gh release download "$pointer" \
    --pattern latest.json \
    --output - \
    --repo "$REPO" 2>/dev/null | jq -r '.version // empty' || true)"
  if [[ -n "$previous" ]]; then
    if [[ "$previous" == "$version" ]]; then
      echo "$pointer already points at $version"
    elif ! node "$semver" --candidate "$version" --current "$previous"; then
      echo "$pointer is at $previous, newer than $version; leaving it untouched"
      exit 0
    fi
  fi
  mapfile -t assets < <(gh release view "$pointer" \
    --json assets --jq '.assets[].name' --repo "$REPO")
  for asset in "${assets[@]}"; do
    if [[ "$asset" != latest.json ]]; then
      echo "Unexpected $pointer asset: $asset" >&2
      exit 1
    fi
  done
else
  # The tag is a fixed anchor, not a commit reference: read the version
  # from latest.json.
  gh release create "$pointer" \
    --latest=false \
    --notes 'Rolling pointer to the latest verified Klex Desktop release of this channel. Carries the updater manifest latest.json only; binaries live on the immutable desktop-v* release it references.' \
    --prerelease \
    --repo "$REPO" \
    --target "$COMMIT" \
    --title "$title"
fi

# A missing asset during --clobber is a clean, retryable failure for the
# updater, unlike a half-updated set of files.
gh release upload "$pointer" "$manifest" --clobber --repo "$REPO"
gh release edit "$pointer" --repo "$REPO" --title "$title -> $version"

promoted="$(mktemp)"
gh release download "$pointer" \
  --pattern latest.json \
  --output "$promoted" \
  --clobber \
  --repo "$REPO"
cmp -s "$manifest" "$promoted" || {
  echo "$pointer serves a different latest.json than the verified one" >&2
  exit 1
}
rm -f "$promoted"

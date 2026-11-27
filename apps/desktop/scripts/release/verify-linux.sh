#!/usr/bin/env bash
# Runs the Klex Desktop AppImage and installs the .deb in clean Ubuntu
# containers, so the checks see what a user's machine has rather than the CI
# runner with its build libraries. The release workflow runs this on signed
# builds and CI on debug bundles.
#
# Usage: verify-linux.sh <AppImage> <deb> <version>
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <AppImage> <deb> <version>" >&2
  exit 2
fi
appimage="$(realpath "$1")"
deb="$(realpath "$2")"
version="$3"
chmod +x "$appimage"

# linuxdeploy leaves these to the host on purpose (its excludelist): the GL
# stack must match the machine's drivers, and every desktop already has
# fontconfig and the X11 and Wayland client libraries.
appimage_host_packages=(
  libdrm2 libegl1 libexpat1 libfontconfig1 libfreetype6 libfribidi0 libgbm1
  libgl1 libharfbuzz0b libwayland-client0 libx11-6 libx11-xcb1 libxcb1
)

for image in ubuntu:22.04 ubuntu:24.04; do
  echo "::group::AppImage on $image"
  docker run --rm \
    --env DEBIAN_FRONTEND=noninteractive \
    --env PACKAGES="${appimage_host_packages[*]}" \
    --volume "$appimage:/verify/klex-desktop.AppImage:ro" \
    "$image" bash -euo pipefail -c '
      apt-get update -qq
      apt-get install --yes --no-install-recommends -qq $PACKAGES >/dev/null
      APPIMAGE_EXTRACT_AND_RUN=1 /verify/klex-desktop.AppImage --daemon --version
    '
  echo "::endgroup::"

  # Nothing preinstalled: the package's Depends must pull in everything.
  echo "::group::.deb on $image"
  docker run --rm \
    --env DEBIAN_FRONTEND=noninteractive \
    --env VERSION="$version" \
    --volume "$deb:/verify/klex-desktop.deb:ro" \
    "$image" bash -euo pipefail -c '
      apt-get update -qq
      apt-get install --yes --no-install-recommends -qq /verify/klex-desktop.deb >/dev/null
      test "$(dpkg-query --show --showformat="\${Version}" klex-desktop)" = "$VERSION"
      /usr/bin/klex-desktop --daemon --version
      apt-get remove --yes -qq klex-desktop >/dev/null
      test ! -e /usr/bin/klex-desktop
    '
  echo "::endgroup::"
done

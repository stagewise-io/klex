#!/bin/sh
# Klex Bot installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/stagewise-io/klex/main/install.sh | sh
#
# The installer is manifest-driven: it reads release-manifest.json from a GitHub
# release, picks the artifact matching this machine, verifies its SHA-256 against
# the manifest, and unpacks it into a versioned directory.
#
# Klex is not a single binary. Each artifact is a directory holding a Node SEA
# executable plus a sibling node_modules with native addons, so the install
# layout is versioned directories behind a symlink:
#
#   $KLEX_INSTALL_DIR/
#     versions/0.1.1/            unpacked artifact
#     current -> versions/0.1.1  repointed on upgrade
#     bin/klex -> ../current/klex   the only entry that goes on PATH
#     install-receipt.json
#
# POSIX sh on purpose: no bash, no arrays, no `local`. Verified by
# `shellcheck --shell=sh install.sh` in CI.

set -eu

KLEX_REPOSITORY='stagewise-io/klex'
KLEX_DEFAULT_CHANNEL='stable'
KLEX_MARKER_BEGIN='# >>> klex installer >>>'
KLEX_MARKER_END='# <<< klex installer <<<'
KLEX_FETCH_ATTEMPTS=4

# Option state. Set by parse_arguments, read everywhere else.
opt_channel=''
opt_version=''
opt_install_dir=''
opt_modify_path='yes'
opt_uninstall='no'

# Resolved state.
klex_target=''
klex_install_dir=''
klex_bin_dir=''
klex_manifest_url=''
klex_staging_dir=''
klex_modified_path_files=''
klex_previous_current=''

# ---------------------------------------------------------------- diagnostics

info() {
	printf 'klex: %s\n' "$1"
}

warn() {
	printf 'klex: warning: %s\n' "$1" >&2
}

die() {
	printf 'klex: error: %s\n' "$1" >&2
	exit 1
}

print_help() {
	cat <<'EOF'
Klex Bot installer

Usage:
  install.sh [options]

Options:
  --version <x.y.z>     Install an exact version instead of the newest release
  --install-dir <path>  Install root (default: ${XDG_DATA_HOME:-~/.local/share}/klex)
  --no-modify-path      Do not touch shell startup files
  --uninstall           Remove the installation, keeping all agent data
  -h, --help            Show this help

Environment:
  KLEX_INSTALL_DIR      Same as --install-dir
  KLEX_HOME             Agent data root (default: ~/.klex); never modified here

Agent data lives outside the install root and survives --uninstall.
EOF
}

# ------------------------------------------------------------------ utilities

cleanup() {
	if [ -n "$klex_staging_dir" ] && [ -d "$klex_staging_dir" ]; then
		rm -rf "$klex_staging_dir"
	fi
}

require_value() {
	# $1 = flag name, $2 = value ('' when the flag was last on the line)
	if [ -z "$2" ]; then
		die "$1 requires a value"
	fi
}

parse_arguments() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
		--channel)
			require_value '--channel' "${2:-}"
			opt_channel="$2"
			shift 2
			;;
		--channel=*)
			opt_channel="${1#--channel=}"
			shift
			;;
		--version)
			require_value '--version' "${2:-}"
			opt_version="$2"
			shift 2
			;;
		--version=*)
			opt_version="${1#--version=}"
			shift
			;;
		--install-dir)
			require_value '--install-dir' "${2:-}"
			opt_install_dir="$2"
			shift 2
			;;
		--install-dir=*)
			opt_install_dir="${1#--install-dir=}"
			shift
			;;
		--no-modify-path)
			opt_modify_path='no'
			shift
			;;
		--uninstall)
			opt_uninstall='yes'
			shift
			;;
		-h | --help)
			print_help
			exit 0
			;;
		*)
			die "unknown option: $1 (try --help)"
			;;
		esac
	done

	if [ -z "$opt_channel" ]; then
		opt_channel="$KLEX_DEFAULT_CHANNEL"
	fi
	case "$opt_channel" in
	stable | nightly) ;;
	*)
		die "unknown channel: $opt_channel"
		;;
	esac
}

resolve_install_dir() {
	if [ -n "$opt_install_dir" ]; then
		klex_install_dir="$opt_install_dir"
	elif [ -n "${KLEX_INSTALL_DIR:-}" ]; then
		klex_install_dir="$KLEX_INSTALL_DIR"
	elif [ -n "${XDG_DATA_HOME:-}" ]; then
		klex_install_dir="$XDG_DATA_HOME/klex"
	else
		klex_install_dir="$HOME/.local/share/klex"
	fi

	case "$klex_install_dir" in
	/*) ;;
	*)
		die "install directory must be an absolute path: $klex_install_dir"
		;;
	esac

	klex_bin_dir="$klex_install_dir/bin"
}

# ------------------------------------------------------------ target detection

detect_musl() {
	# Returns 0 when this Linux uses musl rather than glibc. The release matrix
	# builds -gnu only, so installing here would produce a binary that cannot run.
	if ldd --version 2>&1 | grep -qi musl; then
		return 0
	fi
	for detect_musl_candidate in /lib/ld-musl-*.so.1 /lib/ld-musl-*.so; do
		if [ -e "$detect_musl_candidate" ]; then
			return 0
		fi
	done
	return 1
}

detect_target() {
	detect_target_os="$(uname -s)"
	detect_target_arch="$(uname -m)"

	case "$detect_target_arch" in
	arm64 | aarch64 | armv8*) detect_target_arch='arm64' ;;
	x86_64 | amd64) detect_target_arch='x64' ;;
	*)
		die "unsupported architecture: $detect_target_arch (published builds cover arm64 and x64)"
		;;
	esac

	case "$detect_target_os" in
	Darwin)
		klex_target="darwin-$detect_target_arch"
		;;
	Linux)
		if detect_musl; then
			die 'musl-based Linux is not supported; published Linux builds are glibc (GLIBC_2.28+) only'
		fi
		klex_target="linux-$detect_target_arch-gnu"
		;;
	*)
		die "unsupported operating system: $detect_target_os (macOS and Linux only; use install.ps1 on Windows)"
		;;
	esac
}

# --------------------------------------------------------------------- network

http_download() {
	# $1 = url, $2 = destination path
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 0 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		die 'neither curl nor wget is available'
	fi
}

download_with_retry() {
	# $1 = url, $2 = destination, $3 = human-readable description.
	#
	# The nightly pointer release replaces its manifest asset in place, so the
	# fixed URL can 404 for a moment during a nightly run. A single failure is
	# therefore not evidence that the release is missing.
	download_with_retry_attempt=1
	download_with_retry_delay=2
	while :; do
		if http_download "$1" "$2"; then
			return 0
		fi
		if [ "$download_with_retry_attempt" -ge "$KLEX_FETCH_ATTEMPTS" ]; then
			die "failed to download $3 after $KLEX_FETCH_ATTEMPTS attempts: $1"
		fi
		warn "$3 download failed, retrying in ${download_with_retry_delay}s ($1)"
		sleep "$download_with_retry_delay"
		download_with_retry_delay=$((download_with_retry_delay * 2))
		download_with_retry_attempt=$((download_with_retry_attempt + 1))
	done
}

resolve_manifest_url() {
	if [ -n "${KLEX_MANIFEST_URL:-}" ]; then
		# Internal/testing escape hatch. Accepts file:// for local bundles.
		klex_manifest_url="$KLEX_MANIFEST_URL"
		return 0
	fi

	if [ -n "$opt_version" ]; then
		klex_manifest_url="https://github.com/$KLEX_REPOSITORY/releases/download/v$opt_version/release-manifest.json"
		return 0
	fi

	if [ "$opt_channel" = 'nightly' ]; then
		klex_manifest_url="https://github.com/$KLEX_REPOSITORY/releases/download/channel-nightly/release-manifest.json"
		return 0
	fi

	klex_manifest_url="https://github.com/$KLEX_REPOSITORY/releases/latest/download/release-manifest.json"
}

# ----------------------------------------------------------------- json access
#
# The manifest is small and flat: a few scalar keys plus an artifacts array of
# flat objects. That is narrow enough to read with sed and awk, which avoids
# making jq a hard requirement of a one-line installer.

json_scalar() {
	# $1 = key, $2 = file. Prints the first string or number value for the key.
	sed -n \
		-e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
		-e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
		"$2" | head -n 1
}

json_artifact_object() {
	# $1 = target, $2 = manifest file. Prints the artifact object for the target.
	# Splitting on '{' is safe because artifact objects contain no nested objects.
	awk -v target="$1" '
		BEGIN { RS = "{" }
		$0 ~ "\"target\"[ \t\r\n]*:[ \t\r\n]*\"" target "\"" { print; exit }
	' "$2"
}

json_object_scalar() {
	# $1 = key. Object text on stdin.
	sed -n \
		-e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
		-e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' |
		head -n 1
}

# -------------------------------------------------------------------- checksums

compute_sha256() {
	# $1 = file. Prints the lowercase hex digest.
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	elif command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 "$1" | sed 's/.*= *//'
	else
		die 'no SHA-256 tool found; install one of sha256sum, shasum, or openssl'
	fi
}

verify_archive() {
	# $1 = file, $2 = expected sha256, $3 = expected size in bytes
	verify_archive_actual_size="$(wc -c <"$1" | tr -d ' ')"
	if [ "$verify_archive_actual_size" != "$3" ]; then
		die "archive size mismatch: expected $3 bytes, got $verify_archive_actual_size"
	fi

	verify_archive_actual_sha="$(compute_sha256 "$1")"
	if [ "$verify_archive_actual_sha" != "$2" ]; then
		die "archive checksum mismatch: expected $2, got $verify_archive_actual_sha"
	fi
	info 'checksum verified'
}

# ------------------------------------------------------------------- installing

unpack_archive() {
	# $1 = archive, $2 = version. Unpacks into versions/<version>, atomically.
	unpack_archive_final="$klex_install_dir/versions/$2"
	unpack_archive_tmp="$klex_install_dir/versions/.$2.tmp.$$"

	mkdir -p "$klex_install_dir/versions"
	rm -rf "$unpack_archive_tmp"
	mkdir -p "$unpack_archive_tmp"

	# Artifacts contain a single top-level klex-<version>-<target>/ directory.
	if ! tar -xzf "$1" -C "$unpack_archive_tmp" --strip-components=1; then
		rm -rf "$unpack_archive_tmp"
		die 'failed to unpack the archive'
	fi

	if [ ! -x "$unpack_archive_tmp/klex" ]; then
		rm -rf "$unpack_archive_tmp"
		die 'unpacked archive does not contain an executable named klex'
	fi

	# Replacing an existing directory of the same version is a reinstall.
	rm -rf "$unpack_archive_final"
	mv "$unpack_archive_tmp" "$unpack_archive_final"
}

link_current() {
	# $1 = version. Repoints current at the newly unpacked version, recording the
	# previous target so a failed verification can be rolled back.
	#
	# `ln -sfn`, not `mv` over the old link: when the destination is a symlink to a
	# directory, mv follows it and deposits the new link *inside* the old version
	# directory, silently leaving current pointing at the previous version. `mv -T`
	# would avoid that but is GNU-only, so it is unusable here. -n is understood by
	# both BSD and GNU ln. The cost is that the swap is unlink+symlink rather than
	# rename(2), so a klex process starting in that window may find no current at
	# all; it can never see a half-written link.
	if [ -e "$klex_install_dir/current" ] && [ ! -L "$klex_install_dir/current" ]; then
		die "$klex_install_dir/current exists and is not a symlink; remove it and retry"
	fi

	# Both launcher checks run before current is repointed. Dying after the swap
	# would leave the new version published behind a launcher this run refused to
	# touch, which is a worse state than the one it started in.
	mkdir -p "$klex_bin_dir"
	if [ -e "$klex_bin_dir/klex" ] && [ ! -L "$klex_bin_dir/klex" ]; then
		die "$klex_bin_dir/klex exists and is not a symlink; remove it and retry"
	fi
	# A link with a different target is not ours. That only happens when
	# --install-dir points at a directory someone else manages, and silently
	# replacing their klex launcher is worse than stopping.
	if [ -L "$klex_bin_dir/klex" ] &&
		[ "$(readlink "$klex_bin_dir/klex" 2>/dev/null || true)" != '../current/klex' ]; then
		die "$klex_bin_dir/klex is a symlink this installer did not create; remove it and retry"
	fi

	# readlink, not realpath: a dangling link still has a target worth restoring.
	klex_previous_current="$(readlink "$klex_install_dir/current" 2>/dev/null || true)"

	# Relative target so the whole install root stays relocatable.
	ln -sfn "versions/$1" "$klex_install_dir/current"

	ln -sfn '../current/klex' "$klex_bin_dir/klex"
}

current_points_at_version() {
	# $1 = version. True when current resolves to versions/<version>, whatever form
	# the stored link target happens to take.
	#
	# Resolved physical directories, not the raw readlink string: a link written by
	# hand, by an older layout, or through a symlinked HOME names the same directory
	# in a different form. Callers use this to decide whether a version directory is
	# safe to delete, so a false 'no' would destroy a published installation.
	current_points_at_version_have="$(cd "$klex_install_dir/current" 2>/dev/null && pwd -P)" || return 1
	current_points_at_version_want="$(cd "$klex_install_dir/versions/$1" 2>/dev/null && pwd -P)" || return 1
	[ -n "$current_points_at_version_have" ] || return 1
	[ "$current_points_at_version_have" = "$current_points_at_version_want" ]
}

discard_unpublished_version() {
	# $1 = version. Removes versions/<version> unless current still points at it,
	# which is the same-version reinstall case: that directory is the installation
	# this run failed to replace, so deleting it would break a working install.
	if ! current_points_at_version "$1"; then
		rm -rf "$klex_install_dir/versions/$1"
	fi
}

restore_current() {
	# Undoes link_current after a failed verification, so a broken release never
	# stays published. The bin/klex link is version-independent and needs no undo.
	if [ -n "$klex_previous_current" ]; then
		ln -sfn "$klex_previous_current" "$klex_install_dir/current"
		warn "rolled back: current -> $klex_previous_current"
	else
		rm -f "$klex_install_dir/current"
	fi
}

verify_installation() {
	# $1 = executable to run, $2 = expected version. Returns non-zero instead of
	# dying so the caller can roll back a published link first.
	#
	# A SEA resolves its native addons relative to the realpath of the running
	# executable, so running it through the symlink chain also proves that chain.
	verify_installation_reported="$("$1" --version 2>/dev/null || true)"
	if [ "$verify_installation_reported" != "$2" ]; then
		warn "klex reports version '$verify_installation_reported', expected '$2'"
		return 1
	fi

	# Existence checks cannot prove a native addon loads; --verify-native
	# force-loads every one of them inside the real SEA process.
	if ! verify_installation_output="$("$1" --verify-native 2>&1)"; then
		printf '%s\n' "$verify_installation_output" >&2
		warn 'native dependency verification failed; this build cannot run on this machine'
		return 1
	fi
	return 0
}

# ---------------------------------------------------------------------- receipt

json_escape() {
	# $1 = value. Escapes backslashes and double quotes for embedding in JSON.
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

receipt_path_files_json() {
	# Prints the modifiedPathFiles array body from the newline-separated record.
	receipt_path_files_separator=''
	printf '%s' "$klex_modified_path_files" | while IFS= read -r receipt_path_files_file; do
		[ -n "$receipt_path_files_file" ] || continue
		printf '%s\n    "%s"' "$receipt_path_files_separator" "$(json_escape "$receipt_path_files_file")"
		receipt_path_files_separator=','
	done
}

write_receipt() {
	# $1 = version, $2 = channel, $3 = archive sha256, $4 = manifest url.
	#
	# modifiedPathFiles is what makes --uninstall exact instead of guesswork, and
	# channel is what lets a later self-update resolve the right manifest without
	# asking again.
	write_receipt_path="$klex_install_dir/install-receipt.json"
	write_receipt_tmp="$klex_install_dir/.install-receipt.json.tmp.$$"

	{
		printf '{\n'
		printf '  "schemaVersion": 1,\n'
		printf '  "version": "%s",\n' "$(json_escape "$1")"
		printf '  "channel": "%s",\n' "$(json_escape "$2")"
		printf '  "target": "%s",\n' "$(json_escape "$klex_target")"
		printf '  "installDir": "%s",\n' "$(json_escape "$klex_install_dir")"
		printf '  "binDir": "%s",\n' "$(json_escape "$klex_bin_dir")"
		printf '  "archiveSha256": "%s",\n' "$(json_escape "$3")"
		printf '  "manifestUrl": "%s",\n' "$(json_escape "$4")"
		printf '  "modifiedPathFiles": ['
		receipt_path_files_json
		if [ -n "$klex_modified_path_files" ]; then
			printf '\n  ],\n'
		else
			printf '],\n'
		fi
		printf '  "installedAt": "%s"\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
		printf '}\n'
	} >"$write_receipt_tmp"

	mv -f "$write_receipt_tmp" "$write_receipt_path"
}

# ------------------------------------------------------------------------- path

path_contains_bin_dir() {
	case ":$PATH:" in
	*":$klex_bin_dir:"*) return 0 ;;
	*) return 1 ;;
	esac
}

shell_profile_files() {
	# Prints the startup files for the login shell, one per line. $SHELL is the
	# login shell, which is what a new terminal will actually read; the shell
	# running this script is whatever curl piped into.
	shell_profile_name="$(basename "${SHELL:-}" 2>/dev/null || true)"
	case "$shell_profile_name" in
	zsh)
		printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc"
		;;
	bash)
		# Linux logins read .bashrc; macOS Terminal reads .bash_profile.
		printf '%s\n' "$HOME/.bashrc"
		printf '%s\n' "$HOME/.bash_profile"
		# A bash user with no startup file at all would otherwise get only a created
		# .bashrc, which a login shell (macOS Terminal) never reads, while creating a
		# .bash_profile is refused below because it masks .profile. .profile is read
		# by login bash in exactly that situation. Offered only when nothing else
		# exists, so established setups keep getting a single block.
		if [ ! -f "$HOME/.bashrc" ] && [ ! -f "$HOME/.bash_profile" ] && [ ! -f "$HOME/.bash_login" ]; then
			printf '%s\n' "$HOME/.profile"
		fi
		;;
	fish)
		printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
		;;
	*)
		printf '%s\n' "$HOME/.profile"
		;;
	esac
}

# SC2016: the single quotes are deliberate. `$PATH` has to reach the rc file
# unexpanded so the user's shell expands it at login. Double quotes would freeze
# this installer's PATH into their profile.
# shellcheck disable=SC2016
path_block() {
	# $1 = profile file. Prints the marker-wrapped snippet for that file's syntax.
	# $1 is only pattern-matched below; this function never reads the file.
	printf '%s\n' "$KLEX_MARKER_BEGIN"
	case "$1" in
	*.fish)
		printf 'set -gx PATH "%s" $PATH\n' "$klex_bin_dir"
		;;
	*)
		printf 'export PATH="%s:$PATH"\n' "$klex_bin_dir"
		;;
	esac
	printf '%s\n' "$KLEX_MARKER_END"
}

setup_path() {
	# --no-modify-path still has to walk the profile files. A block written by an
	# earlier run is ours whether or not this run is allowed to write, and the
	# receipt has to keep claiming it; otherwise --uninstall leaves it behind.
	if [ "$opt_modify_path" = 'no' ]; then
		info "skipping PATH setup; add $klex_bin_dir to PATH yourself"
	fi

	# Via a file, not a pipe: a piped while loop runs in a subshell and would
	# discard the record of which files were modified.
	shell_profile_files >"$klex_staging_dir/profiles"

	setup_path_added='no'
	while IFS= read -r setup_path_file; do
		[ -n "$setup_path_file" ] || continue

		# A block this installer already owns has to be recorded even though this run
		# did not write it. Otherwise a reinstall replaces the receipt with one that
		# claims no PATH file was touched, and --uninstall then leaves the block
		# behind forever.
		# Matched on the bin directory too, not the marker alone: the marker is the
		# same for every install root, so a second install under --install-dir would
		# otherwise claim the first one's block and strip it on uninstall.
		#
		# The patterns include the quote and the trailing delimiter that path_block
		# writes, so a bin directory is matched as a whole PATH element. A bare
		# substring search would let /opt/klex/bin claim /opt/klex/bin/bin's block.
		if [ -f "$setup_path_file" ] &&
			grep -qF "$KLEX_MARKER_BEGIN" "$setup_path_file" &&
			grep -qF -e "\"$klex_bin_dir:" -e "\"$klex_bin_dir\"" "$setup_path_file"; then
			klex_modified_path_files="$klex_modified_path_files$setup_path_file
"
			info "PATH entry already present in $setup_path_file"
			continue
		fi

		if [ "$opt_modify_path" = 'no' ]; then
			continue
		fi

		# Nothing of ours in this file, and the directory is already reachable by
		# other means (a user-managed rc file, a system profile). Editing rc files to
		# add a duplicate entry would be noise.
		if path_contains_bin_dir; then
			continue
		fi

		# Only create a file the login shell will actually read. Creating a
		# .bash_profile where none existed changes which files bash sources.
		if [ ! -f "$setup_path_file" ]; then
			case "$setup_path_file" in
			*/.bash_profile) continue ;;
			esac
			mkdir -p "$(dirname "$setup_path_file")"
			: >"$setup_path_file"
		fi

		# SC2094: path_block only matches the name against a glob to pick fish vs
		# POSIX syntax. It never reads the file, so appending is safe.
		# shellcheck disable=SC2094
		{
			printf '\n'
			path_block "$setup_path_file"
		} >>"$setup_path_file"
		klex_modified_path_files="$klex_modified_path_files$setup_path_file
"
		setup_path_added='yes'
		info "added $klex_bin_dir to PATH in $setup_path_file"
	done <"$klex_staging_dir/profiles"

	if path_contains_bin_dir && [ -z "$klex_modified_path_files" ]; then
		info "$klex_bin_dir is already on PATH"
		return 0
	fi

	if [ "$setup_path_added" = 'no' ]; then
		return 0
	fi

	printf '\n'
	printf 'Restart your shell, or run this to use klex now:\n'
	printf '\n'
	# shellcheck disable=SC2016 # literal $PATH: this line is copy-paste advice
	printf '  export PATH="%s:$PATH"\n' "$klex_bin_dir"
}

# -------------------------------------------------------------------- uninstall

receipt_path_files() {
	# $1 = receipt file. Prints each modifiedPathFiles entry on its own line.
	awk '
		/"modifiedPathFiles"/ { collecting = 1 }
		collecting {
			line = $0
			sub(/.*"modifiedPathFiles"[ \t]*:[ \t]*\[/, "", line)
			while (match(line, /"[^"]*"/)) {
				entry = substr(line, RSTART + 1, RLENGTH - 2)
				if (entry != "") print entry
				line = substr(line, RSTART + RLENGTH)
			}
			if (index($0, "]") > 0) exit
		}
	' "$1"
}

strip_path_block() {
	# $1 = profile file, $2 = bin directory this uninstall owns. Removes the marker
	# blocks that reference $2, leaving everything else byte-identical.
	#
	# Scoped by bin directory because the marker text is identical for every install
	# root: a second install elsewhere writes its own block into the same file, and
	# uninstalling one must not take the other's PATH entry with it. The directory is
	# matched as a whole PATH element, quote and delimiter included, so an install
	# root that is a path prefix of another cannot claim the other's block.
	#
	# awk with exact line comparison, not a sed range: a sed range whose closing
	# address never matches deletes everything to end of file. An interrupted
	# install or a hand edit can leave an opening marker without its closing one,
	# and destroying the rest of someone's shell profile is not an acceptable
	# uninstall. Exit 3 means the file ended inside a block; nothing is written.
	if [ ! -f "$1" ]; then
		return 0
	fi
	if ! grep -qF "$KLEX_MARKER_BEGIN" "$1"; then
		return 0
	fi

	strip_path_block_tmp="$1.klex-uninstall.$$"
	if awk -v begin_marker="$KLEX_MARKER_BEGIN" -v end_marker="$KLEX_MARKER_END" -v bin_dir="$2" '
		$0 == begin_marker { in_block = 1; owned = 0; block = $0; next }
		in_block && $0 == end_marker {
			if (!owned) print block "\n" $0
			in_block = 0
			next
		}
		in_block {
			block = block "\n" $0
			if (bin_dir != "" && (index($0, "\"" bin_dir ":") > 0 ||
				index($0, "\"" bin_dir "\"") > 0)) owned = 1
			next
		}
		{ print }
		END { if (in_block) exit 3 }
	' "$1" >"$strip_path_block_tmp"; then
		if cmp -s "$strip_path_block_tmp" "$1"; then
			rm -f "$strip_path_block_tmp"
			info "$1 has no PATH entry for $2; left untouched"
			return 0
		fi
		cat "$strip_path_block_tmp" >"$1"
		rm -f "$strip_path_block_tmp"
		info "removed the PATH entry from $1"
	else
		rm -f "$strip_path_block_tmp"
		warn "$1 has an unterminated klex installer block and was left untouched; remove the lines after '$KLEX_MARKER_BEGIN' by hand"
	fi
}

do_uninstall() {
	resolve_install_dir

	do_uninstall_receipt="$klex_install_dir/install-receipt.json"
	if [ ! -f "$do_uninstall_receipt" ]; then
		# Refusing beats guessing: without a receipt there is no evidence that this
		# directory was created by the installer, and rm -rf on a guess is not safe.
		die "no install receipt at $do_uninstall_receipt; nothing was removed. Pass --install-dir if klex lives elsewhere"
	fi

	do_uninstall_version="$(json_scalar 'version' "$do_uninstall_receipt")"

	# From the receipt, so the blocks removed are the ones this install wrote even
	# when --install-dir differs from the default. Receipts predating this field
	# fall back to the conventional location.
	do_uninstall_bin_dir="$(json_scalar 'binDir' "$do_uninstall_receipt")"
	if [ -z "$do_uninstall_bin_dir" ]; then
		do_uninstall_bin_dir="$klex_install_dir/bin"
	fi

	receipt_path_files "$do_uninstall_receipt" >"$do_uninstall_receipt.paths.$$"
	while IFS= read -r do_uninstall_file; do
		[ -n "$do_uninstall_file" ] || continue
		strip_path_block "$do_uninstall_file" "$do_uninstall_bin_dir"
	done <"$do_uninstall_receipt.paths.$$"
	rm -f "$do_uninstall_receipt.paths.$$"

	rm -rf "$klex_install_dir"
	info "removed klex ${do_uninstall_version:-installation} from $klex_install_dir"

	do_uninstall_home="${KLEX_HOME:-$HOME/.klex}"
	printf '\n'
	printf 'Your agent data was left untouched:\n'
	printf '\n'
	printf '  %s\n' "$do_uninstall_home"
	printf '\n'
	printf 'It holds configuration, credentials, enrollment state, and history.\n'
	printf 'Delete it yourself if you want it gone:\n'
	printf '\n'
	printf '  rm -rf "%s"\n' "$do_uninstall_home"
}

# ------------------------------------------------------------------------- main

do_install() {
	detect_target
	resolve_install_dir
	resolve_manifest_url

	klex_staging_dir="$(mktemp -d 2>/dev/null || mktemp -d -t klex-install)"
	trap cleanup EXIT INT TERM

	info "target $klex_target"
	info "fetching $klex_manifest_url"
	do_install_manifest="$klex_staging_dir/release-manifest.json"
	download_with_retry "$klex_manifest_url" "$do_install_manifest" 'release manifest'

	do_install_schema="$(json_scalar 'schemaVersion' "$do_install_manifest")"
	if [ "$do_install_schema" != '1' ]; then
		die "unsupported manifest schemaVersion '$do_install_schema'; upgrade the installer"
	fi

	do_install_version="$(json_scalar 'version' "$do_install_manifest")"
	if [ -z "$do_install_version" ]; then
		die 'manifest does not contain a version'
	fi
	if [ -n "$opt_version" ] && [ "$do_install_version" != "$opt_version" ]; then
		die "requested version $opt_version but the manifest describes $do_install_version"
	fi

	do_install_artifact="$(json_artifact_object "$klex_target" "$do_install_manifest")"
	if [ -z "$do_install_artifact" ]; then
		die "release $do_install_version has no artifact for $klex_target"
	fi

	do_install_url="$(printf '%s' "$do_install_artifact" | json_object_scalar 'url')"
	do_install_sha="$(printf '%s' "$do_install_artifact" | json_object_scalar 'archiveSha256')"
	do_install_size="$(printf '%s' "$do_install_artifact" | json_object_scalar 'archiveSize')"
	do_install_name="$(printf '%s' "$do_install_artifact" | json_object_scalar 'archiveFileName')"
	if [ -z "$do_install_url" ] || [ -z "$do_install_sha" ] || [ -z "$do_install_size" ]; then
		die "manifest artifact for $klex_target is incomplete"
	fi

	info "installing klex $do_install_version"
	do_install_archive="$klex_staging_dir/$do_install_name"
	download_with_retry "$do_install_url" "$do_install_archive" 'release archive'
	verify_archive "$do_install_archive" "$do_install_sha" "$do_install_size"

	mkdir -p "$klex_install_dir"
	unpack_archive "$do_install_archive" "$do_install_version"

	# Verify before publishing. A release that cannot run must never become the
	# active one, and at this point current still points at the previous version.
	if ! verify_installation "$klex_install_dir/versions/$do_install_version/klex" "$do_install_version"; then
		discard_unpublished_version "$do_install_version"
		die 'the downloaded release does not run on this machine; the existing installation was left in place'
	fi

	link_current "$do_install_version"

	# Again through bin/klex: that is the path users get, and only this proves the
	# symlink chain resolves. A failure here has to be rolled back.
	if ! verify_installation "$klex_bin_dir/klex" "$do_install_version"; then
		restore_current
		# Same cleanup as the pre-publish failure path: once current points back at
		# the previous version, the directory just unpacked is unreferenced.
		discard_unpublished_version "$do_install_version"
		die 'klex does not run through the installed symlinks; the previous version was restored'
	fi
	info 'native dependencies verified'

	setup_path

	do_install_channel="$(json_scalar 'channel' "$do_install_manifest")"
	write_receipt \
		"$do_install_version" \
		"${do_install_channel:-$opt_channel}" \
		"$do_install_sha" \
		"$klex_manifest_url"

	cleanup
	klex_staging_dir=''
	trap - EXIT INT TERM

	info "klex $do_install_version installed to $klex_install_dir"
	printf '\n'
	printf 'Run klex --help to get started.\n'
}

main() {
	parse_arguments "$@"

	if [ "$opt_uninstall" = 'yes' ]; then
		do_uninstall
		return 0
	fi

	do_install
}

main "$@"

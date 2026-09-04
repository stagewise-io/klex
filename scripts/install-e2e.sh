#!/bin/sh
# End-to-end harness for install.sh, driven by a synthetic release bundle.
#
# The installer is fetched and executed straight from the default branch by the
# documented one-liner, so a regression here breaks every new installation. The
# published artifacts cannot be used as fixtures: they are large, they change,
# and reaching the failure paths (checksum mismatch, unloadable native addon,
# foreign launcher) would mean waiting for a broken release. Instead this builds
# tiny fake artifacts that answer --version and --verify-native, served over
# file:// through KLEX_MANIFEST_URL, which lets every code path run offline in a
# couple of seconds.
#
# Runs on macOS and Linux. Every check is reported; the script exits non-zero if
# any of them failed.
#
# Three shellcheck rules are disabled for the whole file, because these patterns
# are harness idioms rather than accidents:
#   SC2319 -- every assertion is a `[ ... ]` or `grep` on one line whose status is
#             consumed by `check` on the very next line. Nothing can overwrite it.
#   SC2251 -- `! grep ...` assertions are intentional. errexit is switched off
#             before the first check, so they must not abort the run.
#   SC2016 -- two grep needles intentionally match literal PowerShell and shell
#             variable references in the installer source.
# shellcheck disable=SC2319,SC2251,SC2016
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The lab directory is wiped with rm -rf on every run, so the caller never gets
# to name it directly: KLEX_E2E_LAB only chooses the parent, and a fixed final
# component is always appended. Pointing it at $HOME therefore erases
# $HOME/klex-e2e-lab, not $HOME.
LAB_PARENT="${KLEX_E2E_LAB:-${TMPDIR:-/tmp}}"
case "$LAB_PARENT" in
/*) ;;
*)
	printf 'KLEX_E2E_LAB must be an absolute path: %s\n' "$LAB_PARENT" >&2
	exit 1
	;;
esac
LAB="${LAB_PARENT%/}/klex-e2e-lab"

# Mirrors detect_target in install.sh. The manifest has to advertise the target
# the installer will ask for, or every case would fail on 'no artifact for'.
case "$(uname -m)" in
arm64 | aarch64 | armv8*) ARCH='arm64' ;;
x86_64 | amd64) ARCH='x64' ;;
*)
	printf 'unsupported architecture for this harness: %s\n' "$(uname -m)" >&2
	exit 1
	;;
esac
case "$(uname -s)" in
Darwin) TARGET="darwin-$ARCH" ;;
Linux) TARGET="linux-$ARCH-gnu" ;;
*)
	printf 'unsupported operating system for this harness: %s\n' "$(uname -s)" >&2
	exit 1
	;;
esac

sha256_of() {
	# $1 = file. Linux ships sha256sum, macOS ships shasum; neither is on both.
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		printf 'neither sha256sum nor shasum is available\n' >&2
		exit 1
	fi
}

rm -rf "$LAB"
mkdir -p "$LAB/serve" "$LAB/home" "$LAB/build"

pack_artifact() {
	# $1 = version, $2 = the shell body for the --verify-native branch. Packaging
	# lives here only, so a working and a broken artifact can never drift apart in
	# anything except the behaviour under test.
	art="$LAB/build/klex-$1-$TARGET"
	rm -rf "$art"
	mkdir -p "$art/node_modules"
	cat >"$art/klex" <<EOF
#!/bin/sh
case "\$1" in
--version) printf '%s\n' '$1' ;;
--verify-native) $2 ;;
*) printf 'Usage: klex [options]\n' ;;
esac
EOF
	chmod +x "$art/klex"
	(cd "$LAB/build" && tar -czf "$LAB/serve/klex-$1-$TARGET.tar.gz" "klex-$1-$TARGET")
}

make_artifact() {
	# $1 = version
	pack_artifact "$1" "printf 'all native dependencies loaded\\n'"
}

make_broken_artifact() {
	# $1 = version. Reports the right version but fails --verify-native, which is
	# what a build with an unloadable native addon looks like.
	pack_artifact "$1" "printf 'cannot load node_modules/better-sqlite3\\n' >&2; exit 1"
}

stray_dotentries() {
	# $1 = directory. Prints any dot entry inside it, ignoring . and .. -- pure
	# shell globbing, so no find implementation or flag support is involved and a
	# tool error cannot turn the assertion into a silent pass.
	for sd_entry in "$1"/.[!.]* "$1"/..?*; do
		[ -e "$sd_entry" ] && printf '%s\n' "$sd_entry"
	done
}

write_manifest() {
	# $1 = version, $2 = sha override ('' to use the real digest),
	# $3 = channel (defaults to nightly).
	mv_file="$LAB/serve/klex-$1-$TARGET.tar.gz"
	mv_size="$(wc -c <"$mv_file" | tr -d ' ')"
	mv_sha="$(sha256_of "$mv_file")"
	if [ -n "$2" ]; then mv_sha="$2"; fi
	mv_channel="${3:-nightly}"
	cat >"$LAB/serve/release-manifest.json" <<EOF
{
  "channel": "$mv_channel",
  "gitCommit": "0000000000000000000000000000000000000000",
  "schemaVersion": 1,
  "version": "$1",
  "artifacts": [
    {
      "archiveFileName": "klex-$1-$TARGET.tar.gz",
      "archiveSha256": "$mv_sha",
      "archiveSize": $mv_size,
      "nodeVersion": "26.8.1",
      "notarized": false,
      "signed": false,
      "target": "$TARGET",
      "url": "file://$LAB/serve/klex-$1-$TARGET.tar.gz",
      "verified": false
    }
  ]
}
EOF
}

run_installer_in() {
	# $1 = HOME, $2 = install dir, rest = installer arguments.
	#
	# env -i so the harness never inherits a real KLEX_* variable or an XDG path
	# that would move the install root out from under the assertions.
	ri_home="$1"
	ri_dir="$2"
	shift 2
	env -i \
		HOME="$ri_home" \
		PATH="$PATH" \
		SHELL=/bin/bash \
		KLEX_MANIFEST_URL="file://$LAB/serve/release-manifest.json" \
		sh "$REPO_ROOT/install.sh" --install-dir "$ri_dir" "$@"
}

run_installer() {
	run_installer_in "$LAB/home" "$LAB/home/opt/klex" "$@"
}

run_installer_with_env() {
	# $1 = one extra NAME=VALUE pair, rest = installer arguments.
	#
	# Kept separate from run_installer_in because that one builds its environment
	# from literal assignments; a pair passed as a single quoted word lets a case
	# add exactly one KLEX_* variable without reintroducing word splitting.
	riwe_pair="$1"
	shift
	env -i \
		HOME="$LAB/home" \
		PATH="$PATH" \
		SHELL=/bin/bash \
		KLEX_MANIFEST_URL="file://$LAB/serve/release-manifest.json" \
		"$riwe_pair" \
		sh "$REPO_ROOT/install.sh" --install-dir "$LAB/home/opt/klex" "$@"
}

run_ok_in() {
	# $1 = label, $2 = log file, $3 = HOME, $4 = install dir, rest = arguments.
	#
	# Every invocation that is expected to succeed goes through here, so its exit
	# status becomes a check of its own. Discarding the status with `|| true` would
	# let a failed run pass the following assertions vacuously: unchanged rc files,
	# a marker block from an earlier install, or a stale receipt all look correct
	# when nothing happened at all.
	rok_label="$1"
	rok_log="$2"
	rok_home="$3"
	rok_dir="$4"
	shift 4
	run_installer_in "$rok_home" "$rok_dir" "$@" >"$rok_log" 2>&1
	check "$rok_label" "$?"
}

run_ok() {
	# $1 = label, $2 = log file, rest = arguments. Default home and install root.
	rok_l="$1"
	rok_f="$2"
	shift 2
	run_ok_in "$rok_l" "$rok_f" "$LAB/home" "$LAB/home/opt/klex" "$@"
}

check() {
	# $1 = label, $2 = exit status the caller already produced
	if [ "$2" = '0' ]; then
		printf 'PASS  %s\n' "$1"
	else
		printf 'FAIL  %s\n' "$1"
		fails=$((fails + 1))
	fi
}

# Checks below deliberately evaluate failing conditions, so errexit must be off
# from here on; the harness reports failures itself.
set +e

fails=0
ROOT="$LAB/home/opt/klex"

printf '\n== 1. fresh install ==\n'
make_artifact 1.0.0
write_manifest 1.0.0 ''
run_ok 'install exits zero' "$LAB/install1.log"
grep -q 'installed to' "$LAB/install1.log"
check 'install reports success' "$?"
[ "$("$ROOT/bin/klex" --version)" = '1.0.0' ]
check 'bin/klex runs and reports 1.0.0' "$?"
[ "$(readlink "$ROOT/current")" = 'versions/1.0.0' ]
check 'current points at versions/1.0.0' "$?"
grep -q '"version": "1.0.0"' "$ROOT/install-receipt.json"
check 'receipt records the version' "$?"
grep -q "$LAB/home/.bashrc" "$ROOT/install-receipt.json"
check 'receipt records the modified PATH file' "$?"
grep -q '>>> klex installer >>>' "$LAB/home/.bashrc"
check 'bashrc carries the marker block' "$?"
[ ! -f "$LAB/home/.bash_profile" ]
check 'no .bash_profile invented' "$?"

printf '\n== 2. idempotent re-run ==\n'
run_ok 'the re-run exits zero' "$LAB/install1b.log"
[ "$(grep -c '>>> klex installer >>>' "$LAB/home/.bashrc")" = '1' ]
check 'PATH block not duplicated' "$?"

printf '\n== 3. upgrade ==\n'
make_artifact 2.0.0
write_manifest 2.0.0 ''
run_ok 'the upgrade exits zero' "$LAB/install2.log"
[ "$("$ROOT/bin/klex" --version)" = '2.0.0' ]
check 'bin/klex now reports 2.0.0' "$?"
[ "$(readlink "$ROOT/current")" = 'versions/2.0.0' ]
check 'current repointed' "$?"
[ -d "$ROOT/versions/1.0.0" ]
check 'old version directory retained' "$?"
[ -z "$(stray_dotentries "$ROOT/versions/1.0.0")" ]
check 'no stray temp link left inside the old version' "$?"

printf '\n== 4. checksum mismatch aborts ==\n'
make_artifact 3.0.0
write_manifest 3.0.0 '0000000000000000000000000000000000000000000000000000000000000000'
run_installer >"$LAB/install3.log" 2>&1 && bad=1 || bad=0
check 'installer exits non-zero' "$bad"
grep -q 'checksum mismatch' "$LAB/install3.log"
check 'reports a checksum mismatch' "$?"
[ ! -d "$ROOT/versions/3.0.0" ]
check 'nothing unpacked for the bad version' "$?"
[ "$("$ROOT/bin/klex" --version)" = '2.0.0' ]
check 'existing install untouched' "$?"

printf '\n== 5. --no-modify-path leaves rc files byte-identical ==\n'
write_manifest 2.0.0 ''
cp "$LAB/home/.bashrc" "$LAB/bashrc.before"
run_ok 'install exits zero' "$LAB/install4.log" --no-modify-path
cmp -s "$LAB/bashrc.before" "$LAB/home/.bashrc"
check 'bashrc unchanged' "$?"

printf '\n== 6. uninstall ==\n'
printf 'echo tail-line\n' >>"$LAB/home/.bashrc"
run_ok 'the install to be removed exits zero' "$LAB/install4b.log"
mkdir -p "$LAB/home/.klex/agents/default"
printf '{}\n' >"$LAB/home/.klex/agents/default/config.json"
run_ok 'uninstall exits zero' "$LAB/uninstall.log" --uninstall
[ ! -d "$ROOT" ]
check 'install root removed' "$?"
! grep -q 'klex installer' "$LAB/home/.bashrc"
check 'marker block stripped from bashrc' "$?"
! grep -q 'export PATH' "$LAB/home/.bashrc"
check 'PATH export line stripped from bashrc' "$?"
grep -q 'tail-line' "$LAB/home/.bashrc"
check 'unrelated bashrc content preserved' "$?"
[ -f "$LAB/home/.klex/agents/default/config.json" ]
check 'KLEX_HOME data left intact' "$?"
grep -q 'left untouched' "$LAB/uninstall.log"
check 'uninstall explains the surviving data' "$?"

printf '\n== 7. uninstall without a receipt refuses ==\n'
run_installer --uninstall >"$LAB/uninstall2.log" 2>&1 && bad=1 || bad=0
check 'exits non-zero' "$bad"
grep -q 'no install receipt' "$LAB/uninstall2.log"
check 'explains why' "$?"

printf '\n== 8. unknown option and missing artifact ==\n'
run_installer --bogus >"$LAB/bogus.log" 2>&1 && bad=1 || bad=0
check 'unknown option exits non-zero' "$bad"
write_manifest 2.0.0 ''
sed 's/"target": "[^"]*"/"target": "linux-riscv-gnu"/' "$LAB/serve/release-manifest.json" >"$LAB/serve/rm.tmp"
mv "$LAB/serve/rm.tmp" "$LAB/serve/release-manifest.json"
run_installer >"$LAB/notarget.log" 2>&1 && bad=1 || bad=0
check 'missing target exits non-zero' "$bad"
grep -q 'no artifact for' "$LAB/notarget.log"
check 'names the missing target' "$?"

printf '\n== 9. failed verification never becomes the active version ==\n'
make_artifact 2.0.0
write_manifest 2.0.0 ''
run_ok 'the baseline install exits zero' "$LAB/install4c.log"
make_broken_artifact 4.0.0
write_manifest 4.0.0 ''
run_installer >"$LAB/install5.log" 2>&1 && bad=1 || bad=0
check 'installer exits non-zero' "$bad"
[ "$(readlink "$ROOT/current")" = 'versions/2.0.0' ]
check 'current still points at the working version' "$?"
[ "$("$ROOT/bin/klex" --version)" = '2.0.0' ]
check 'bin/klex still runs the working version' "$?"
[ ! -d "$ROOT/versions/4.0.0" ]
check 'the broken version directory was discarded' "$?"
grep -q 'left in place' "$LAB/install5.log"
check 'says the existing installation survived' "$?"

printf '\n== 10. reinstall with --no-modify-path keeps PATH ownership ==\n'
make_artifact 2.0.0
write_manifest 2.0.0 ''
run_ok 'reinstall exits zero' "$LAB/install6.log" --no-modify-path
grep -q "$LAB/home/.bashrc" "$ROOT/install-receipt.json"
check 'receipt still claims the profile it owns' "$?"
run_ok 'uninstall exits zero' "$LAB/uninstall4.log" --uninstall
! grep -q 'klex installer' "$LAB/home/.bashrc"
check 'uninstall still strips the block' "$?"

printf '\n== 11. an unterminated block is not deleted through EOF ==\n'
make_artifact 2.0.0
write_manifest 2.0.0 ''
run_ok 'the install exits zero' "$LAB/install6b.log"
# What an interrupted install or a hand edit leaves behind: opening marker, no
# closing marker, unrelated content after it.
grep -v '<<< klex installer <<<' "$LAB/home/.bashrc" >"$LAB/bashrc.cut"
cp "$LAB/bashrc.cut" "$LAB/home/.bashrc"
printf 'echo important-tail\n' >>"$LAB/home/.bashrc"
cp "$LAB/home/.bashrc" "$LAB/bashrc.broken"
run_ok 'uninstall exits zero' "$LAB/uninstall5.log" --uninstall
cmp -s "$LAB/bashrc.broken" "$LAB/home/.bashrc"
check 'profile left byte-identical' "$?"
grep -q 'important-tail' "$LAB/home/.bashrc"
check 'content after the block preserved' "$?"
grep -q 'unterminated' "$LAB/uninstall5.log"
check 'warns about the unterminated block' "$?"

printf '\n== 12. two install roots share one profile ==\n'
ROOT2="$LAB/home/opt/klex-alt"
make_artifact 2.0.0
write_manifest 2.0.0 ''
rm -rf "$ROOT" "$ROOT2"
printf 'echo tail-line\n' >"$LAB/home/.bashrc"
run_ok 'the first root installs' "$LAB/install7a.log"
run_ok_in 'the second root installs' "$LAB/install7.log" "$LAB/home" "$ROOT2"
[ "$(grep -c '>>> klex installer >>>' "$LAB/home/.bashrc")" = '2' ]
check 'second install root writes its own block' "$?"
grep -q "$ROOT2" "$ROOT2/install-receipt.json"
check 'second receipt claims its own bin dir' "$?"
run_ok_in 'the second root uninstalls' "$LAB/uninstall6.log" "$LAB/home" "$ROOT2" --uninstall
! grep -q "$ROOT2/bin" "$LAB/home/.bashrc"
check 'uninstall strips only its own block' "$?"
grep -q "$ROOT/bin" "$LAB/home/.bashrc"
check "the other root's PATH entry survives" "$?"
run_ok 'the first root uninstalls' "$LAB/uninstall7.log" --uninstall
! grep -q 'klex installer' "$LAB/home/.bashrc"
check 'the last block is removed too' "$?"
grep -q 'tail-line' "$LAB/home/.bashrc"
check 'unrelated content still intact' "$?"

printf '\n== 13. a foreign bin/klex is refused, not overwritten ==\n'
make_artifact 2.0.0
write_manifest 2.0.0 ''
rm -rf "$ROOT"
mkdir -p "$ROOT/bin"
ln -sfn /bin/echo "$ROOT/bin/klex"
run_installer >"$LAB/install8.log" 2>&1 && bad=1 || bad=0
check 'installer exits non-zero' "$bad"
grep -q 'did not create' "$LAB/install8.log"
check 'explains that the launcher is not ours' "$?"
[ "$(readlink "$ROOT/bin/klex")" = '/bin/echo' ]
check 'the foreign launcher is left alone' "$?"

# The same refusal during an upgrade must not publish the new version: the
# launcher check runs before current is repointed.
rm -rf "$ROOT"
run_ok 'the baseline install exits zero' "$LAB/install8a.log"
rm -f "$ROOT/bin/klex"
ln -sfn /bin/echo "$ROOT/bin/klex"
make_artifact 5.0.0
write_manifest 5.0.0 ''
run_installer >"$LAB/install8b.log" 2>&1 && bad=1 || bad=0
check 'the upgrade exits non-zero too' "$bad"
[ "$(readlink "$ROOT/current")" = 'versions/2.0.0' ]
check 'current was not repointed to the unpublished version' "$?"

printf '\n== 14. bash with no startup file at all gets .profile ==\n'
make_artifact 2.0.0
write_manifest 2.0.0 ''
BARE="$LAB/bare-home"
rm -rf "$BARE"
mkdir -p "$BARE"
run_ok_in 'install into a bare home exits zero' "$LAB/install9.log" "$BARE" "$BARE/opt/klex"
grep -q '>>> klex installer >>>' "$BARE/.profile"
check '.profile carries the block' "$?"
[ ! -f "$BARE/.bash_profile" ]
check 'no .bash_profile invented' "$?"
# Per file, not summed: two blocks in .bashrc and none in .profile would keep a
# total of 2 while violating the property this asserts.
[ "$(grep -c '>>> klex installer >>>' "$BARE/.bashrc")" = '1' ]
check 'exactly one block in .bashrc' "$?"
[ "$(grep -c '>>> klex installer >>>' "$BARE/.profile")" = '1' ]
check 'exactly one block in .profile' "$?"

printf '\n== 15. an install root that is a path prefix of another ==\n'
# /x/pfx/bin and /x/pfx/bin/bin: a substring test on the bin directory would let
# the outer root claim and strip the inner root's PATH block.
PFX="$LAB/home/opt/pfx"
PFX_IN="$PFX/bin"
make_artifact 2.0.0
write_manifest 2.0.0 ''
rm -rf "$PFX"
printf 'echo tail-line\n' >"$LAB/home/.bashrc"
run_ok_in 'the outer root installs' "$LAB/install10.log" "$LAB/home" "$PFX"
run_ok_in 'the inner root installs' "$LAB/install11.log" "$LAB/home" "$PFX_IN"
[ "$(grep -c '>>> klex installer >>>' "$LAB/home/.bashrc")" = '2' ]
check 'both roots get their own block' "$?"
grep -qF "$PFX_IN/bin" "$PFX_IN/install-receipt.json"
check 'the inner receipt names its own bin dir' "$?"
run_ok_in 'the outer root uninstalls' "$LAB/uninstall8.log" "$LAB/home" "$PFX" --uninstall
! grep -qF "\"$PFX/bin:" "$LAB/home/.bashrc"
check "the outer root's own block is stripped" "$?"
grep -qF "\"$PFX_IN/bin:" "$LAB/home/.bashrc"
check "the inner root's block survives" "$?"
grep -q 'tail-line' "$LAB/home/.bashrc"
check 'unrelated content still intact' "$?"

printf '\n== 16. KLEX_CHANNEL and KLEX_VERSION are honoured behind their flags ==\n'
# The install root is irrelevant here: every case is decided by argument and
# environment resolution, which happens before anything is written.
make_artifact 2.0.0
write_manifest 2.0.0 ''
rm -rf "$ROOT"

# A bogus channel is only rejected if the variable was read at all. Before the
# environment fallback existed, this run silently resolved the default channel
# and succeeded, which is exactly the failure mode being locked down.
run_installer_with_env 'KLEX_CHANNEL=bogus' >"$LAB/env1.log" 2>&1 && bad=1 || bad=0
check 'KLEX_CHANNEL=bogus exits non-zero' "$bad"
grep -q 'unknown channel: bogus' "$LAB/env1.log"
check 'names the rejected channel' "$?"
[ ! -d "$ROOT" ]
check 'nothing installed for the bogus channel' "$?"

run_installer_with_env 'KLEX_CHANNEL=bogus' --channel stable >"$LAB/env2.log" 2>&1
check '--channel overrides KLEX_CHANNEL' "$?"
[ "$("$ROOT/bin/klex" --version)" = '2.0.0' ]
check 'the override actually installed' "$?"

# KLEX_VERSION reaches the manifest/version cross-check, so a pin the manifest
# cannot satisfy proves the variable was read rather than ignored.
run_installer_with_env 'KLEX_VERSION=9.9.9' >"$LAB/env3.log" 2>&1 && bad=1 || bad=0
check 'KLEX_VERSION=9.9.9 exits non-zero' "$bad"
grep -q 'requested version 9.9.9' "$LAB/env3.log"
check 'names the requested version' "$?"

run_installer_with_env 'KLEX_VERSION=9.9.9' --version 2.0.0 >"$LAB/env4.log" 2>&1
check '--version overrides KLEX_VERSION' "$?"

# Uninstalling consults no release metadata, so a stale channel export in the
# caller's shell must not be able to refuse the removal.
run_installer_with_env 'KLEX_CHANNEL=bogus' --uninstall >"$LAB/env5.log" 2>&1
check 'uninstall ignores an invalid KLEX_CHANNEL' "$?"
[ ! -d "$ROOT" ]
check 'the install root is gone' "$?"

printf '\n== 17. manifest URL contract is channel-specific ==\n'
# Put a deterministic curl in front of PATH. It records every URL while still
# copying the synthetic manifest and artifacts, so these are behavioral tests
# of the installer's actual URL selection rather than source-text assertions.
mkdir -p "$LAB/mock-bin"
cat >"$LAB/mock-bin/curl" <<'EOF'
#!/bin/sh
while [ "$#" -gt 0 ]; do
	case "$1" in
	-o)
		destination="$2"
		shift 2
		;;
	*)
		url="$1"
		shift
		;;
	esac
done
printf '%s\n' "$url" >>"$MOCK_CURL_LOG"
case "$url" in
file://*) cp "${url#file://}" "$destination" ;;
*/release-manifest.json) cp "$MOCK_MANIFEST" "$destination" ;;
*) exit 22 ;;
esac
EOF
chmod +x "$LAB/mock-bin/curl"

exercise_manifest_url() {
	# $1 = expected URL fragment, rest = installer arguments.
	expected_url="$1"
	shift
	rm -rf "$ROOT"
	: >"$LAB/curl-urls.log"
	env -i \
		HOME="$LAB/home" \
		PATH="$LAB/mock-bin:$PATH" \
		SHELL=/bin/bash \
		MOCK_CURL_LOG="$LAB/curl-urls.log" \
		MOCK_MANIFEST="$LAB/serve/release-manifest.json" \
		sh "$REPO_ROOT/install.sh" --install-dir "$ROOT" --no-modify-path "$@" >/dev/null
	grep -qF "$expected_url" "$LAB/curl-urls.log"
}

make_artifact 2.1.0
write_manifest 2.1.0 '' stable
exercise_manifest_url 'releases/download/channel-stable/release-manifest.json' --channel stable
check 'Unix stable resolves channel-stable' "$?"
write_manifest 2.1.0 '' nightly
exercise_manifest_url 'releases/download/channel-nightly/release-manifest.json' --channel nightly
check 'Unix nightly resolves channel-nightly' "$?"
write_manifest 2.1.0 '' stable
exercise_manifest_url 'releases/download/v2.1.0/release-manifest.json' --version 2.1.0
check 'Unix exact version resolves its immutable tag' "$?"

# PowerShell is unavailable on the Unix matrix. Anchor each assertion to the
# branch that returns it so swapping stable/nightly URLs fails this check.
awk '/if \(\$ResolvedChannel -eq .nightly.\)/ { getline; if ($0 ~ /channel-nightly/) nightly=1 } /return .*channel-stable/ { stable=1 } END { exit !(nightly && stable) }' "$REPO_ROOT/install.ps1"
check 'PowerShell maps stable and nightly pointer URLs' "$?"
awk '/if \(\$pinned\)/ { getline; if ($0 ~ /releases\/download\/v\$pinned\/release-manifest.json/) pinned=1 } END { exit !pinned }' "$REPO_ROOT/install.ps1"
check 'PowerShell exact version resolves its immutable tag' "$?"

printf '\n'
if [ "$fails" -eq 0 ]; then
	printf 'ALL CHECKS PASSED\n'
else
	printf '%s CHECK(S) FAILED\n' "$fails"
	exit 1
fi

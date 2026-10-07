#!/bin/sh
# Smoke-tests a klex container image under the production runtime contract:
# read-only root filesystem, tmpfs /tmp, non-root user, one named volume.
#
# Usage: smoke-image.sh <image-ref> <expected-version>
#
# Checks: version, native dependencies, user and PID 1, headless startup,
# graceful SIGTERM drain, restart on the same volume after a clean stop and
# after SIGKILL.
#
# Not checked: two containers on one volume. The directory lock compares PIDs,
# which are local to a PID namespace, so it cannot see another container. The
# orchestrator guarantees one container per volume (see README.md).
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <image-ref> <expected-version>" >&2
  exit 2
fi

image=$1
expected_version=$2
run_id="klex-smoke-$$-$(date +%s)"
volume=$run_id
first="$run_id-first"
restarted="$run_id-restarted"
crashed="$run_id-crashed"
recovered="$run_id-recovered"
lock_file=/data/agent/.klex.lock
ready_timeout_s=60
stop_timeout_s=60
# The compact log format carries the level only as the logger-name colour:
# bold red marks ERROR and FATAL. Structured fields of INFO lines are not
# printed, so lifecycle checks match stable messages.
error_marker=$(printf '\033[1m\033[31m')

cleanup() {
  docker rm -f "$first" "$restarted" "$crashed" "$recovered" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ok() {
  echo "ok: $*"
}

fail() {
  echo "FAIL: $1" >&2
  if [ "$#" -gt 1 ]; then
    echo "--- logs of $2 ---" >&2
    docker logs "$2" >&2 2>&1 || true
    echo "--- end of logs ---" >&2
  fi
  exit 1
}

# Runs the image with the flags every hosted deployment uses.
klex_run() {
  docker run \
    --read-only \
    --tmpfs /tmp \
    -e KLEX_NO_CLOUD=1 \
    -e KLEX_NO_ANALYTICS=1 \
    -v "$volume:/data" \
    "$@"
}

is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

exit_code_of() {
  docker inspect -f '{{.State.ExitCode}}' "$1"
}

# wait_for_log <container> <fixed-string> <timeout-seconds>
wait_for_log() {
  elapsed=0
  while [ "$elapsed" -lt "$3" ]; do
    if docker logs "$1" 2>&1 | grep -qF -- "$2"; then
      return 0
    fi
    if ! is_running "$1"; then
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

# stop_gracefully <container>: SIGTERM, expect drain and exit code 0.
stop_gracefully() {
  docker stop -t "$stop_timeout_s" "$1" >/dev/null
  code=$(exit_code_of "$1")
  [ "$code" = "0" ] || fail "$1 exited with $code after SIGTERM" "$1"
  docker logs "$1" 2>&1 | grep -qF 'Agent drain finished' ||
    fail "$1 did not drain on SIGTERM" "$1"
  if docker logs "$1" 2>&1 | grep -qF -e "$error_marker" -e 'FATAL'; then
    fail "$1 logged errors" "$1"
  fi
}

docker volume create "$volume" >/dev/null
# Headless mode never onboards: the orchestrator provisions config.json.
docker run --rm --read-only -v "$volume:/data" --entrypoint sh "$image" \
  -c 'mkdir -p /data/agent && echo "{}" > /data/agent/config.json'

# 1. Version
version=$(klex_run --rm "$image" --version) ||
  fail "--version exited non-zero"
[ "$version" = "$expected_version" ] ||
  fail "--version printed '$version', expected '$expected_version'"
ok "version $version"

# 2. Native dependencies load under the runtime contract
if ! output=$(klex_run --rm "$image" --verify-native 2>&1); then
  echo "$output" >&2
  fail "--verify-native exited non-zero"
fi
ok "native dependencies load"

# 3. Non-root user and tini entrypoint
uid=$(docker run --rm --entrypoint id "$image" -u)
[ "$uid" = "10001" ] || fail "image runs as uid $uid, expected 10001"
entrypoint=$(docker image inspect -f '{{json .Config.Entrypoint}}' "$image")
[ "$entrypoint" = '["/usr/bin/tini","--","/opt/klex/klex"]' ] ||
  fail "unexpected entrypoint $entrypoint"
ok "uid 10001, entrypoint tini"

# 4. Headless startup on a fresh volume
klex_run -d --name "$first" "$image" >/dev/null
wait_for_log "$first" 'Klex Bot ready' "$ready_timeout_s" ||
  fail "$first did not become ready within ${ready_timeout_s}s" "$first"
pid1=$(docker exec "$first" cat /proc/1/comm)
[ "$pid1" = "tini" ] || fail "PID 1 is '$pid1', expected tini"
ok "headless runtime ready, PID 1 is tini"

# 5. Graceful stop
stop_gracefully "$first"
ok "SIGTERM drained and exited 0"

# 6. Restart on the same volume
klex_run -d --name "$restarted" "$image" >/dev/null
wait_for_log "$restarted" 'Klex Bot ready' "$ready_timeout_s" ||
  fail "restart did not become ready within ${ready_timeout_s}s" "$restarted"
stop_gracefully "$restarted"
ok "restart on the same volume is ready and stops cleanly"

# 7. Restart after a crash. SIGKILL leaves the lock file behind, and the new
# container's klex usually gets the same low PID as the old one.
klex_run -d --name "$crashed" "$image" >/dev/null
wait_for_log "$crashed" 'Klex Bot ready' "$ready_timeout_s" ||
  fail "$crashed did not become ready within ${ready_timeout_s}s" "$crashed"
docker kill -s KILL "$crashed" >/dev/null
docker wait "$crashed" >/dev/null
docker run --rm -v "$volume:/data" --entrypoint test "$image" -e "$lock_file" ||
  fail "SIGKILL did not leave $lock_file behind; the crash path is not exercised"
klex_run -d --name "$recovered" "$image" >/dev/null
wait_for_log "$recovered" 'Klex Bot ready' "$ready_timeout_s" ||
  fail "restart after SIGKILL did not become ready within ${ready_timeout_s}s" "$recovered"
docker logs "$recovered" 2>&1 | grep -qF 'Removing stale working directory lock' ||
  fail "$recovered did not report the stale lock" "$recovered"
stop_gracefully "$recovered"
ok "restart after SIGKILL replaces the stale lock and stops cleanly"

echo "All container smoke checks passed for $image"

# Klex container image

`ghcr.io/stagewise-io/klex` runs Klex Bot headless on Linux, for `linux/arm64` and `linux/amd64`. The image holds the same files as the release archive for that platform. Nothing is rebuilt in Docker, so every image carries a payload that already passed `--verify-native` and the glibc 2.28 baseline check.

## Tags

| Tag | Moves | Published by |
|-----|-------|--------------|
| `:<version>`, e.g. `:0.13.3` | never | stable and nightly releases |
| `:stable` | after `verify-stable-install` passes | stable releases |
| `:nightly` | on each nightly, never backwards | nightly releases |

There is no `:latest`. Deployments should pin by digest (`ghcr.io/stagewise-io/klex@sha256:...`) and treat the rolling tags as a way to look up the digest.

## Runtime contract

| Item | Value |
|------|-------|
| Install path | `/opt/klex/`, root-owned and read-only |
| User | uid/gid `10001` (`klex`), non-root |
| Entrypoint | `/usr/bin/tini -- /opt/klex/klex`, empty `CMD` |
| Env set by the image | `KLEX_HOME=/data`, `KLEX_DATA_DIR=/data/agent`, `HOME=/data/home`, `KLEX_HEADLESS=1` |
| Writable mounts | `/data` (persistent volume), `/tmp` (tmpfs or `emptyDir`) |
| Not set by the image | `KLEX_DEPLOYMENT`, cloud and enrollment variables |

Headless mode comes from `KLEX_HEADLESS`, not from `CMD`. That keeps `docker run <image> --version` and `--verify-native` working without overrides.

The image runs with a read-only root filesystem. Klex writes in three places outside `/opt/klex`:

- the data directory under `/data/agent`
- `$HOME/.cache/klex/native`, where it extracts the LiveKit addon at runtime. This is why `HOME` points into the volume.
- `os.tmpdir()`, used by the JavaScript sandbox, so `/tmp` must be writable.

The volume must be writable by uid 10001. Docker named volumes copy the owner of the image's `/data` into a new volume, so they work as is. Kubernetes volumes and bind mounts don't get that copy. On Kubernetes, set `securityContext.fsGroup: 10001` on the pod, ideally with `fsGroupChangePolicy: OnRootMismatch` so large volumes aren't re-chowned on every start.

The image has no `VOLUME` instruction. Without a mount on `/data`, startup fails on the read-only root filesystem instead of writing into an anonymous volume that disappears with the container.

Leave `KLEX_AUTO_UPDATE` off. A container updates by switching to a new image.

## Provisioning

Headless Klex never runs onboarding. `/data/agent/config.json` must exist before the first start, or startup fails with `Required local data store "config" is missing`. `{}` is enough to start. The launcher writes the real config, with model providers.

## Signals and shutdown

On SIGTERM Klex stops taking new work, waits for the running turn to finish, acknowledges the Push Notifications it handled, and exits 0. Events that arrive during the drain stay in the server's pending queue for the next start. A second SIGTERM skips the wait. See [`src/drain/architecture.md`](../src/drain/architecture.md).

tini runs as PID 1 and reaps the processes Klex spawns: stdio MCP servers, ffmpeg, and the sandbox worker. It runs without `-g`, so SIGTERM reaches Klex alone. Klex then drains and stops its own children. With `-g`, the children would die mid-turn.

Set the orchestrator's grace period above `KLEX_DRAIN_TIMEOUT_MS + KLEX_SHUTDOWN_TIMEOUT_MS` plus a margin. With the defaults (300 s + 15 s), use about 330 s, e.g. `terminationGracePeriodSeconds: 330`. A shorter grace period is safe but wasteful: work still running at SIGKILL is lost and its events get delivered again.

## HTTP probes

Set `KLEX_HEALTH_PORT=8080` or `--health-port 8080` to enable the dedicated probe listener. It is disabled by default. `KLEX_HEALTH_HOST` defaults to `0.0.0.0` so kubelet can reach the pod IP. The listener exposes only `GET /livez` and `GET /readyz`; all other requests return 404. It exposes no Admin API or agent data.

- `/livez` returns 200 whenever the event loop can answer, including startup and drain.
- `/readyz` returns 503 during startup, 200 after the runtime is ready, and 503 as soon as termination, an update drain, or shutdown begins. It does not check cloud connectivity or model-provider configuration.
- A bind failure aborts startup. The listener starts before directory locking and local-data migrations, and closes after runtime teardown.

```yaml
env:
  - name: KLEX_HEALTH_PORT
    value: "8080"
ports:
  - name: health
    containerPort: 8080
startupProbe:
  httpGet: { path: /livez, port: health }
  periodSeconds: 5
  failureThreshold: 60
livenessProbe:
  httpGet: { path: /livez, port: health }
  periodSeconds: 20
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /readyz, port: health }
  periodSeconds: 5
```

The startup probe proves the listener can respond, not that migrations finished. Readiness gates traffic separately. Restrict ingress to the probe port using the pod's network policy.

## One container per volume

Run at most one container per data volume. Two Klex processes on one data directory corrupt its SQLite stores.

Klex's directory lock can't prevent this across containers. The lock records a PID, and PIDs only mean something inside one PID namespace. A second container can't tell whether the first one is alive, so it treats the lock as stale and takes it over. The lock does protect one container, or one host without containers, against a second Klex process.

On Kubernetes the guarantee comes from the platform:

- Run each bot as a StatefulSet with one replica. It never starts a replacement pod until the old one has terminated.
- Use `accessModes: [ReadWriteOncePod]` on the volume claim. `ReadWriteOnce` still lets two pods on the same node mount the volume.
- Never force-delete a bot pod (`kubectl delete pod --force --grace-period=0`). That removes the pod from the API while its process keeps running, and a replacement on the same node can mount the volume next to it.

## Logs

Klex writes its compact log format to stdout. Each line shows time, module, and message. Two limits matter for log collection:

- The level shows only as the color of the module name. ERROR and FATAL are bold red. FATAL startup errors also print a full multi-line record.
- Structured fields print only for WARN, ERROR, and FATAL. The `event.name` of INFO lines, such as `drain.started` and `drain.finished`, appears only in OTLP export.

Stable messages to match on:

| Message | Meaning |
|---------|---------|
| `Klex Bot ready` | startup finished, SIGTERM handling installed |
| `Agent drain finished` | SIGTERM drain completed |
| `Klex Bot startup failed` | startup aborted, process exits non-zero |

## Building locally

The image needs Linux binaries, so on macOS the build runs inside a Node container. Use the Node version from `.nvmrc` and the matching architecture.

```bash
# From the repository root
mkdir -p apps/klex/container/context
docker run --rm \
  -v "$PWD":/src:ro \
  -v "$PWD/apps/klex/container/context":/out \
  -w /work node:26.8.1-bookworm bash -ec '
    cd /src && git config --global --add safe.directory /src
    git ls-files -co --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C /work
    cd /work && npm i -g pnpm@11.22.0 && pnpm install --frozen-lockfile
    pnpm -F @stagewise/klex test:exe
    pnpm -F @stagewise/klex container:stage -- --output /out'

version=$(node -p "require('./apps/klex/package.json').version")
docker build -t klex:local --build-arg KLEX_VERSION="$version" \
  -f apps/klex/container/Dockerfile apps/klex/container/context
sh apps/klex/container/smoke-image.sh klex:local "$version"
```

On Linux, run `test:exe` and `container:stage` directly.

`smoke-image.sh` checks the version, native dependencies under a read-only root as uid 10001, tini as PID 1, headless startup on a fresh volume, a SIGTERM drain with exit 0, a restart after a clean stop, and a restart after SIGKILL that leaves its lock file behind. `smoke-health.mjs` also holds startup at a directory-lock FIFO and holds a real model turn at a local response gate. Both states must answer `/livez` with 200 and `/readyz` with 503; releasing the turn must let SIGTERM exit 0. The fixture uses a local fake model and a pinned Node client container sharing the agent's network namespace. It publishes no Admin API port and needs no model credentials. Node must be available on the test host. It doesn't check the cross-container case from the previous section, because the lock can't detect it.

## Running

```bash
docker volume create klex-data
docker run --rm -v klex-data:/data --entrypoint sh ghcr.io/stagewise-io/klex:stable \
  -c 'mkdir -p /data/agent && [ -f /data/agent/config.json ] || echo "{}" > /data/agent/config.json'
docker run -d --name klex --read-only --tmpfs /tmp -v klex-data:/data \
  --stop-timeout 330 ghcr.io/stagewise-io/klex:stable
```

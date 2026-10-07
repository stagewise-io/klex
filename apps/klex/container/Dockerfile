# syntax=docker/dockerfile:1
#
# klex runtime image. The build context is a staged distribution directory,
# not the repository: `context/klex/` holds exactly the contents of a release
# archive (see apps/klex/container/README.md). Nothing is compiled here.

# debian:bookworm-slim (multi-arch index). glibc 2.36 >= the 2.28 baseline the
# release workflow enforces.
ARG BASE_IMAGE=debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

# Normalize file modes before the payload reaches the final image. Some npm
# binaries ship as 0744 (ffprobe), which works for a user who owns the install
# but not for a non-root user running root-owned files. a+rX grants read to all
# and execute wherever any execute bit is already set.
FROM ${BASE_IMAGE} AS payload
COPY klex/ /opt/klex/
RUN chmod -R a+rX,go-w /opt/klex

FROM ${BASE_IMAGE}

ARG KLEX_VERSION=0.0.0-dev
ARG KLEX_REVISION=unknown

LABEL org.opencontainers.image.title="klex" \
      org.opencontainers.image.description="Klex Bot agent runtime (headless)" \
      org.opencontainers.image.source="https://github.com/stagewise-io/klex" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${KLEX_VERSION}" \
      org.opencontainers.image.revision="${KLEX_REVISION}"

# libatomic1: the Node runtime inside the SEA links libatomic.so.1, which slim
# images do not ship. ldd on every packaged binary and addon shows no other gap.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates libatomic1 tini \
 && rm -rf /var/lib/apt/lists/*

# /data is owned by klex. Only Docker named volumes copy this owner into a new
# volume. Kubernetes volumes and bind mounts do not, so the pod must set
# securityContext.fsGroup: 10001 (see README.md).
# There is deliberately no VOLUME instruction: on a read-only root filesystem a
# missing mount must fail loudly instead of writing into an anonymous volume.
RUN groupadd --gid 10001 klex \
 && useradd --uid 10001 --gid 10001 --home-dir /data/home --no-create-home \
      --shell /usr/sbin/nologin klex \
 && mkdir -p /data \
 && chown 10001:10001 /data

COPY --from=payload --chown=root:root /opt/klex/ /opt/klex/

# HOME lives on the volume: the LiveKit addon is extracted to
# $HOME/.cache/klex/native at runtime and the root filesystem is read-only.
ENV KLEX_HOME=/data \
    KLEX_DATA_DIR=/data/agent \
    HOME=/data/home \
    KLEX_HEADLESS=1

USER 10001:10001
WORKDIR /data

# tini reaps zombies from klex's child processes (stdio MCP servers, ffmpeg,
# sandbox worker). No -g: SIGTERM must reach klex alone so it can drain and
# then stop its children itself.
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/klex/klex"]
CMD []

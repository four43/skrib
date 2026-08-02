# syntax=docker/dockerfile:1

# base → {plugin-pkg, fe-deps → fe-build} → py-deps → dev → runtime.
#
# runtime is the LAST stage, so a bare `docker build .` (or a compose build that
# forgets --target) fails closed to the hardened, non-root production image. The
# devcontainer opts into dev explicitly via build.target: dev in
# .devcontainer/docker-compose.override.yml.
#
# Design notes: docs/specs/2026-08-02-docker-multistage-nonroot-design.md
# Fleet conventions: xwc-data-meta/docs/devcontainers.md §2

ARG PYTHON_IMAGE=python:3.14-slim
ARG NODE_IMAGE=node:22-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11

# COPY --from does not expand variables, so the uv image needs a stage alias.
FROM ${UV_IMAGE} AS uv-bin

FROM ${PYTHON_IMAGE} AS base
# Marks every container built from any stage as in-Docker.
ENV IN_DOCKER=true \
    PYTHONUNBUFFERED=1
WORKDIR /app


# ─── plugin-pkg: plugin frontend manifests, directory structure preserved ────
# COPY with a wildcard flattens paths, so `COPY backend/plugins/*/frontend/
# package*.json` cannot preserve the per-plugin layout a cache-friendly npm
# layer needs. This stage rebuilds that layout with find, so fe-deps below
# re-runs only when a manifest actually changes.
FROM busybox AS plugin-pkg
COPY backend/plugins/ /src/
RUN find /src -path '*/frontend/package*.json' -exec sh -c \
        'dest="/out/${1#/src/}" && mkdir -p "$(dirname "$dest")" && cp "$1" "$dest"' _ {} \;


# ─── fe-deps: node_modules for the main frontend + all plugin frontends ──────
# Manifests only — cached until a package.json or lockfile changes.
FROM ${NODE_IMAGE} AS fe-deps
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./frontend/
COPY --from=plugin-pkg /out/ ./backend/plugins/
COPY frontend/util/install-plugins ./frontend/util/
RUN cd frontend && npm ci
RUN ./frontend/util/install-plugins


# ─── fe-build: plugin bundles + vite build, staged into /artifacts ───────────
# Build-time only. The COPYs merge into the existing tree rather than replacing
# it, and .dockerignore keeps host node_modules out of the context, so the
# installed dependencies above survive.
FROM fe-deps AS fe-build
COPY frontend/ ./frontend/
COPY backend/plugins/ ./backend/plugins/
# /artifacts mirrors the repo-relative paths (cp --parents) so runtime can
# restore every built asset with one COPY, without dragging node_modules along.
RUN ./frontend/util/build \
    && mkdir -p /artifacts \
    && cp --parents -r frontend/dist /artifacts/ \
    && for d in backend/plugins/*/frontend/dist; do cp --parents -r "$d" /artifacts/; done


# ─── py-deps: runtime Python dependencies into /usr/local ────────────────────
# Also the parent of the dev stage, which keeps this toolchain (uv, git).
# Deliberately installs NO extras: runtime copies /usr/local from here, so dev
# dependencies cannot reach production by forgetting a build arg.
FROM base AS py-deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv-bin /uv /uvx /usr/local/bin/

# Install into the system Python prefix instead of a venv — this is a container,
# the whole filesystem is the isolation boundary. Copy linking avoids hardlink
# warnings when the cache and target are on different filesystems. UV_FROZEN
# makes a stale uv.lock a build failure rather than a silent re-resolve.
ENV UV_PROJECT_ENVIRONMENT=/usr/local \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_FROZEN=1

COPY backend/pyproject.toml backend/uv.lock ./backend/
COPY backend/util/install-dependencies ./backend/util/
RUN --mount=type=cache,target=/root/.cache/uv \
    ./backend/util/install-dependencies


# ─── dev: devcontainer target — py-deps toolchain, dropped to app-user ───────
# Keeps uv/git, adds the dev extra plus every tool the devcontainer needs baked
# in (nothing is apt-installed at container-create time). Runs as the SAME
# non-root uid-1000 app-user runtime ships as, so file-permission bugs surface
# in dev and bind-mounted files stay owned by the host user. Passwordless sudo
# covers root-ish dev chores and lives ONLY in this stage.
# NOT the last stage, so a bare `docker build .` still yields runtime.
FROM py-deps AS dev

RUN --mount=type=cache,target=/root/.cache/uv \
    ./backend/util/install-dependencies dev

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        bat \
        curl \
        fd-find \
        fzf \
        git-lfs \
        jq \
        less \
        openssh-client \
        ripgrep \
        sudo \
        tree \
        vim \
    # Debian ships these under alternate names to avoid collisions.
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && ln -sf /usr/bin/batcat /usr/local/bin/bat

# Seed GitHub host keys system-wide, not into root's known_hosts: the container
# runs as app-user, who cannot read /root (devcontainers.md §2, gotcha 8).
RUN ssh-keyscan github.com >> /etc/ssh/ssh_known_hosts

# Node toolchain for the frontend and plugin builds. Taken from fe-deps, which
# is itself ${NODE_IMAGE}, so dev and the build stages can't drift apart.
COPY --from=fe-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=fe-deps /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN useradd --create-home --shell /bin/bash --uid 1000 app-user \
    # useradd leaves the password locked (!); an sshd running UsePAM no refuses
    # pubkey login to a locked account (devcontainers.md §2, gotcha 5). An empty
    # password is safe — such an sshd also runs PermitEmptyPasswords no.
    && passwd -d app-user \
    && echo 'app-user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/app-user \
    && chmod 0440 /etc/sudoers.d/app-user \
    # Pre-create the VS Code server dir owned by app-user, before any bind mount
    # exists. The devcontainer mounts the extensions cache below this path; if
    # the parents don't already exist Docker creates them root:root and the
    # non-root server can't mkdir its siblings (devcontainers.md §2, gotcha 1).
    && install -d -o app-user -g app-user /home/app-user/.vscode-server \
    && chown -R app-user:app-user /app

# node_modules for the devcontainer, at the path the workspace mounts on. The
# named volumes in .devcontainer/docker-compose.override.yml are seeded from
# these image paths on first create — the bind mount over /workspace does not
# interfere. --chown avoids duplicating ~180MB in a second chown layer.
COPY --chown=app-user:app-user --from=fe-deps /app/ /workspace/

# Browsers go to a shared path, not $HOME/.cache/ms-playwright: installed as
# root that resolves to /root/.cache, mode 0700, unreadable by uid 1000.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd /workspace/frontend \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

# USER does not update $HOME — a bare docker exec or compose run would inherit
# the base image's /root (devcontainers.md §2, gotcha 7).
ENV HOME=/home/app-user
WORKDIR /workspace
USER app-user
EXPOSE 8000 5173
CMD ["sleep", "infinity"]


# ─── runtime: Python + built assets only, no node/npm/uv/git/sudo ────────────
# LAST stage = default build target = what production ships. The frontend is
# served by FastAPI StaticFiles from frontend/dist (backend/skrib/main.py), so
# the shipped image needs no Node at all.
FROM base AS runtime

RUN useradd --create-home --shell /bin/bash --uid 1000 app-user \
    # config.py calls DB_DIR.mkdir(exist_ok=True) without parents=True, so the
    # data dir must already exist and be writable by uid 1000.
    && install -d -o app-user -g app-user /data

COPY --from=py-deps /usr/local /usr/local
COPY --chown=app-user:app-user . .
COPY --chown=app-user:app-user --from=fe-build /artifacts/ ./

# uv rode in with the /usr/local prefix; production has no use for it.
RUN rm -f /usr/local/bin/uv /usr/local/bin/uvx

# Dependencies are installed with --no-install-project, so skrib and
# skrib_plugin_sdk are imported from the source tree rather than site-packages.
ENV HOME=/home/app-user \
    SKRIB_DATA_DIR=/data \
    PYTHONPATH=/app/backend

WORKDIR /app/backend
USER app-user
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "skrib.main:app", "--host", "0.0.0.0", "--port", "8000"]

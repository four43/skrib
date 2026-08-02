# Docker multi-stage, non-root build + devcontainer with baked-in tooling

**Date:** 2026-08-02
**Status:** Approved design, ready for implementation planning

## Problem

The current `Dockerfile` and `.devcontainer/` setup has four concrete problems:

1. **Everything runs as root.** Both the dev container and the production target
   run as root, so container writes into bind mounts land root-owned on the host,
   and permission bugs stay hidden until they reach production.
2. **The "production" image is not lean.** `production` is `FROM base`, which
   already carries Node, npm, pip, all `node_modules` for the main frontend plus
   7 plugin frontends, and dev-only Python dependencies. Nothing is dropped.
3. **The image layout and the compose mounts disagree.** The image places the repo
   at `/app` (`/app/backend`, `/app/frontend`), but `docker-compose.yml` mounts
   `./backend:/app`, `./frontend:/frontend`, `./data:/data`. It only works because
   the mounts shadow the image, so the image layout is effectively dead.
4. **Dev tooling is installed on every container create.** `on-create.sh`
   apt-installs `git git-lfs fzf jq vim` each time, slowing every rebuild.

There is also a latent hazard: `docker-compose.yml` mounts a shared host path over
the container's `/tmp`. Under root this is harmless; under a non-root user it
deadlocks devcontainer setup with no error message
(`~/projects/VaisalaCorp/xwc-data-meta/docs/devcontainers.md`, closing ⚠️).

## Goals

- A production image that ships only what it needs to serve the app, as a
  non-root user.
- A dev image that is a *superset* for developer convenience but shares the
  production identity (uid 1000), with all dev tooling baked in.
- One coherent path layout across image, compose, and devcontainer.
- Follow the `xwc-*` fleet conventions
  (`xwc-data-meta/docs/devcontainers.md` §2, `xwc-product-data/Dockerfile`),
  deviating only where skrib's shape genuinely differs.

## Non-goals

- Changing how the app itself works. No application code changes.
- Adding CI. skrib has no `.github/` workflows; this design does not add any.
- Joining the `xwe-mesh` SSH mesh. The pubkey mount stays where it is today, in
  the personal gitignored `docker-compose.override.dev.yml`.
- Restructuring the plugin frontends into npm workspaces (which would collapse
  the 8 `node_modules` trees into one). Out of scope.

## Key facts that shape the design

- **Production needs no Node.** `backend/skrib/main.py:141` serves the built
  frontend with `StaticFiles` from `STATIC_DIR`, which
  `backend/skrib/config.py:19` resolves to `<repo>/frontend/dist`. Node is a
  build-time dependency only.
- **Backend paths derive from `__file__`,** not from the working directory
  (`config.py:6`, `BACKEND_ROOT = Path(__file__).parent.parent`), so the repo can
  live at `/app` or `/workspace` without any code change.
- **The e2e harness already prefers a venv.** `frontend/tests/e2e/fixtures.js:46`
  `findVenvPython()` checks `backend/.venv/bin/python`, then the main repo's venv
  for worktrees, then falls back to `python` on `$PATH`. A uv-managed
  `backend/.venv` on the host is picked up automatically; inside the container uv
  installs into `/usr/local`, so the `python` fallback resolves correctly.
- **All 8 frontends have a `package-lock.json`,** so `npm ci` is viable
  everywhere.
- **`data/` must be writable by uid 1000.** Host ownership was fixed by the
  developer on 2026-08-02, prior to implementation.

## Design

### 1. Dockerfile — six stages, `runtime` last

```
base (python:3.14-slim, IN_DOCKER=true, WORKDIR /app)
├── plugin-pkg  (busybox)      — extract plugin frontend package*.json, structure preserved
├── fe-deps     (node:22-slim) — npm ci + install-plugins → all 8 node_modules trees
│   └── fe-build               — build plugin bundles + vite build → /artifacts
├── py-deps     (FROM base)    — uv → runtime deps only, into /usr/local
│   └── dev     (FROM py-deps) — + dev extras, node, dev tools, Playwright, app-user
└── runtime     (FROM base)    — LAST: /usr/local + source + built dist, app-user
```

`runtime` is the last stage, so a bare `docker build .` fails closed to the
hardened production image. The devcontainer opts into `dev` explicitly via
`build.target: dev`.

Base images: `python:3.14-slim` and `node:22-slim`, both as `ARG`s so they can be
overridden or pinned to a patch version later.

#### `plugin-pkg`

Kept from the current Dockerfile. It exists because `COPY` with a wildcard
flattens paths, so `COPY backend/plugins/*/frontend/package*.json` cannot preserve
the per-plugin directory structure needed for a cache-friendly dependency layer.
The busybox stage copies just the manifests with `find -exec`, preserving
structure.

#### `fe-deps`

```dockerfile
FROM ${NODE_IMAGE} AS fe-deps
WORKDIR /app
COPY frontend/package*.json ./frontend/
COPY --from=plugin-pkg /out/plugins/ ./backend/plugins/
COPY frontend/util/install-plugins ./frontend/util/
RUN cd frontend && npm ci
RUN ./frontend/util/install-plugins
```

Manifests only, so this layer is cached until a `package.json` or lockfile
changes.

#### `fe-build`

Adds the frontend and plugin sources, runs the existing build script, then stages
the outputs into `/artifacts` so the runtime copy cannot drag `node_modules` in
with it:

```dockerfile
FROM fe-deps AS fe-build
COPY frontend/ ./frontend/
COPY backend/plugins/ ./backend/plugins/
RUN ./frontend/util/build \
 && mkdir -p /artifacts \
 && cp --parents -r frontend/dist /artifacts/ \
 && for d in backend/plugins/*/frontend/dist; do cp --parents -r "$d" /artifacts/; done
```

`--parents` preserves the repo-relative path, so `/artifacts` mirrors the tree and
the runtime can restore it with a single `COPY --from=fe-build /artifacts/ ./`.
`node:22-slim` is Debian-based and has GNU coreutils, so `cp --parents` is
available. The `COPY` lines cannot clobber the installed `node_modules`: `COPY`
merges into existing directories, and `.dockerignore` excludes `**/node_modules`
from the build context.

#### `py-deps`

```dockerfile
FROM base AS py-deps
# apt: git, ca-certificates (build-time only)
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /uvx /usr/local/bin/
ENV UV_PROJECT_ENVIRONMENT=/usr/local \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_FROZEN=1
COPY backend/pyproject.toml backend/uv.loc[k] ./backend/
COPY backend/util/install-dependencies ./backend/util/
RUN --mount=type=cache,target=/root/.cache/uv \
    cd backend && ./util/install-dependencies
```

Installs into the system prefix rather than a venv — the container *is* the
isolation boundary. `uv.loc[k]` is the optional-file glob trick, so the build
still works before the lockfile is generated.

**Deviation from the fleet, deliberate:** `xwc-product-data` has a single
`builder` stage with `ARG INSTALL_GROUPS=dev`, and its `runtime` copies
`/usr/local` from that stage — so production ships pytest unless the caller
remembers to override the arg. Here, `py-deps` installs **runtime dependencies
only** and the `dev` stage layers the `dev` extra on top. `runtime` copies from
`py-deps`, so dev dependencies cannot reach production by omission. The base
dependency layer is still shared between the two images.

#### `dev`

`FROM py-deps`, keeping uv and git. As root it:

- runs `./util/install-dependencies dev` to add the `dev` extra;
- copies node and npm from `${NODE_IMAGE}` using the existing
  `COPY --from=… /usr/local/bin/node` + `npm-cli.js` symlink approach;
- apt-installs `sudo git-lfs jq vim fzf curl openssh-client ripgrep fd-find bat
  less tree` (with `--mount=type=cache` on the apt dirs);
- creates `app-user` at uid 1000, `passwd -d app-user` (fleet gotcha 5 — a locked
  account is refused by a `UsePAM no` sshd), a NOPASSWD sudoers drop-in, and
  pre-creates `/home/app-user/.vscode-server/` owned by the user (fleet gotcha 1
  — otherwise Docker creates the bind-mount parent root-owned and the VS Code
  server install fails);
- seeds the dev `node_modules` with `COPY --from=fe-deps /app/ /workspace/`;
- installs Playwright Chromium with `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`
  followed by `chmod -R a+rX /ms-playwright`. The default location is
  `$HOME/.cache/ms-playwright`; installed as root that is `/root/.cache`, mode
  0700, unreadable by uid 1000;
- `chown -R app-user:app-user /app /workspace`;
- sets `ENV HOME=/home/app-user` **before** `USER app-user` (fleet gotcha 7 —
  `USER` does not update `$HOME`, and VS Code masks this while `docker exec` and
  `docker compose run` do not).

`sudo` exists only in this stage. Per the fleet doc, `NOPASSWD:ALL` is
root-equivalent; the security value is in the production image and in stage
isolation keeping sudo out of it.

#### `runtime`

```dockerfile
FROM base AS runtime
COPY --from=py-deps /usr/local /usr/local
COPY . .
COPY --from=fe-build /artifacts/ ./
RUN rm -f /usr/local/bin/uv /usr/local/bin/uvx \
 && useradd --create-home --shell /bin/bash --uid 1000 app-user \
 && install -d -o app-user -g app-user /data \
 && chown -R app-user:app-user /app
ENV HOME=/home/app-user \
    SKRIB_DATA_DIR=/data \
    PYTHONPATH=/app/backend
WORKDIR /app/backend
USER app-user
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "skrib.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- `/usr/local` carries uv because `py-deps` put it there, so it is removed.
- `/data` is created in the image because `config.py:14` calls
  `DB_DIR.mkdir(exist_ok=True)` without `parents=True`, so the directory must
  already exist and be writable by uid 1000.
- `PYTHONPATH` is set because dependencies are installed with
  `--no-install-project`; the `skrib` and `skrib_plugin_sdk` packages are
  imported from the source tree, not from site-packages.
- The image contains no node, npm, uv, git, ssh, or sudo. `pip` remains, because
  it ships inside the `/usr/local` prefix copied from `py-deps`; removing it
  would mean picking apart the prefix, which is not worth it. The fleet's
  `runtime` keeps pip for the same reason.

### 2. Path layout

One layout, used consistently:

| Context | Repo root | Data dir |
| --- | --- | --- |
| Image (`runtime`) | `/app` (`/app/backend`, `/app/frontend/dist`) | `/data` via `SKRIB_DATA_DIR` |
| `docker-compose.yml` | image copy, **not** bind-mounted | `./data:/data` |
| Devcontainer | `./:/workspace` | `/workspace/data` (default, `SKRIB_DATA_DIR` unset) |

`SKRIB_DATA_DIR` is set in the `runtime` stage only, never in compose. The `dev`
stage does not inherit it, so the devcontainer falls back to the repo-relative
`data/` directory it uses today.

### 3. `docker-compose.yml` — a production smoke test

Builds the default `runtime` target and runs it as shipped.

- **No source bind mount.** Mounting `./:/app` would shadow the image's built
  `frontend/dist` with whatever the host happens to have, defeating the purpose.
  This is a deliberate deviation from the fleet's `./:/app`, which exists there to
  support CI `docker compose run` against the checkout; skrib has no CI.
- Keeps `./data:/data`, `PYTHONUNBUFFERED=1`, `init: true`, port 8000.
- **Removed:** the `caddy_data`/`caddy_config` volumes (declared with no caddy
  service — dead config); `entrypoint: ""` (the image has no `ENTRYPOINT`); the
  `./backend:/app` + `./frontend:/frontend` split mounts; the
  `${BITBUCKET_CLONE_DIR:-/tmp}:/tmp` mount (the non-root deadlock antipattern);
  `secrets: github_token` and `ssh: default` (skrib has only public
  dependencies, and `ssh: default` fails the build when no agent is running); the
  inline `npm run dev` + `uvicorn --reload` command, which moves to the
  devcontainer override.

### 4. `.devcontainer/docker-compose.override.yml`

Carries all dev behavior:

- `build.target: dev`, `container_name`/`hostname: skrib` (unchanged).
- `./:/workspace`, `/tmp/app-container:/host/tmp:rw`.
- Cache mounts relocated from `/root/…` to `/home/app-user/…`
  (`.vscode-server/extensions`, `.gitconfig`).
- Ports 5173 (vite) and 8080 (WebRTC research) added; 8000 comes from the base
  file.
- `PYTHONPATH=/workspace/backend`. Today it is `/workspace`, which cannot import
  `skrib` — the package lives at `backend/skrib`.
- `command: sleep infinity`.
- Eight named volumes over the bind mount, one per `node_modules` tree:

```yaml
volumes:
  - skrib-node-modules-frontend:/workspace/frontend/node_modules
  - skrib-node-modules-attachments:/workspace/backend/plugins/four43.attachments/frontend/node_modules
  - skrib-node-modules-chat-typing:/workspace/backend/plugins/four43.chat-typing/frontend/node_modules
  - skrib-node-modules-emoji-picker:/workspace/backend/plugins/four43.emoji-picker/frontend/node_modules
  - skrib-node-modules-message-reactions:/workspace/backend/plugins/four43.message-reactions/frontend/node_modules
  - skrib-node-modules-room-type-chat:/workspace/backend/plugins/four43.room-type-chat/frontend/node_modules
  - skrib-node-modules-room-type-todo:/workspace/backend/plugins/four43.room-type-todo/frontend/node_modules
  - skrib-node-modules-web-push:/workspace/backend/plugins/four43.web-push/frontend/node_modules
```

Docker seeds each named volume from the **image's** filesystem at that path on
first use — the bind mount at `/workspace` does not interfere. This is the
standard bind-mount-plus-volume idiom, and it is why the `dev` stage stages
`node_modules` at `/workspace` rather than only at `/app`.

Consequences, accepted:

- Container and host keep separate `node_modules`, so native binaries cannot
  conflict and container work never touches the host install.
- Named volumes persist and are not re-seeded after first creation, so a
  `package.json` change needs either `docker volume rm` or an install inside the
  container. `on-create.sh` covers this with an idempotent `npm install`.
- Adding a plugin frontend means adding a volume line. Documented in
  `CLAUDE.md`.

### 5. `.devcontainer/on-create.sh`

Shrinks to what cannot be baked into an image:

- A sudo guard (`SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"`)
  so the script still works when it runs as root.
- `ssh-keyscan github.com | $SUDO tee -a /etc/ssh/ssh_known_hosts` — fleet gotcha
  8: build-time host keys land in root's `known_hosts`, which the non-root user
  cannot read.
- `npm install` + `./util/install-plugins` as an idempotent self-heal for a stale
  `node_modules` volume. A no-op in the common case.
- The Claude hydration block, **with a bug fix**: it currently tests
  `/host/.claude`, but `docker-compose.override.dev.yml` mounts `~/.claude` at
  `/host/home/.claude`, so hydration silently never runs. Corrected to read
  `/host/home/.claude` and write `$HOME/.claude` instead of the hardcoded
  `/root/.claude`.

Removed: all apt installs (baked into the `dev` stage) and `chmod 1777 /tmp`
(unnecessary once nothing is mounted over `/tmp`).

### 6. `.devcontainer/devcontainer.json`

Adds `"remoteUser": "app-user"`. Everything else is unchanged.

### 7. uv migration

- Generate `backend/uv.lock` with the host's uv (0.11.32).
- Keep `[project.optional-dependencies].dev` rather than moving to PEP 735
  dependency groups, so `pip install .[dev]` keeps working for anyone not using
  uv.
- Rewrite `backend/util/install-dependencies` as a thin uv wrapper taking an
  optional comma-separated extras list. The current script's pip/lockfile/`pip
  freeze`/`/opt/xwe-python-app`/`chown` logic is xwe-specific and does not apply
  here. `UV_FROZEN=1` is set in the Dockerfile so container builds refuse to
  update the lockfile, while host runs may.
- `frontend/util/install-plugins` uses `npm ci` when a `package-lock.json` is
  present, falling back to `npm install`. All 8 frontends have one today.

### 8. `.dockerignore`

Add `backend/plugins/*/frontend/dist` (built in the image; a stale host build must
not be copied in), plus `.worktrees`, `.playwright-mcp`, `frontend/test-results`,
and `frontend/playwright-report`. `frontend/dist`, `**/node_modules`, and `data/`
are already excluded.

### 9. Documentation

- `CLAUDE.md`: update the Running section (`pip install -e .` →
  `./util/install-dependencies dev`), and note the per-plugin `node_modules`
  volume line required when adding a plugin frontend.
- `backend/README.md`: same dependency-install change.

## Verification

Production image:

- `docker compose build` succeeds with no `--target`, producing `runtime`.
- `docker compose run --rm app id` reports uid 1000.
- `docker compose run --rm app sh -c 'command -v node npm uv sudo git'` finds
  none of them (`pip` is expected to remain — see the `runtime` notes).
- `docker compose up` serves the app on `:8000` from the baked `frontend/dist`,
  with plugin bundles loading.
- The database is created under the `./data` bind mount and is host-user owned.

Devcontainer:

- Rebuild succeeds; `id` reports uid 1000 `app-user`; `sudo true` works.
- `git`, `git-lfs`, `jq`, `vim`, `fzf`, `rg`, `fd`, `bat`, `tree`, `node`, `npm`
  are all on `$PATH` without on-create installing anything.
- `cd frontend && npm run dev` serves on 5173.
- `cd frontend && ./util/test-e2e` passes.
- `cd backend && python -m pytest test_plugin_bus/ -v` passes.
- Files created in the container are owned by the host user, not root.
- `grep -rn ':/tmp' docker-compose*.yml .devcontainer/` returns only the
  `/host/tmp` remap.

## Risks

- **Python 3.13 → 3.14.** Dependency wheels (Pillow, pywebpush, py-vapid,
  websockets) must exist for 3.14. The fleet already runs 3.14, so this is
  expected to be fine, but it is the most likely build-time failure. The
  `PYTHON_IMAGE` ARG allows a fast fallback to `python:3.13-slim`.
- **Node 20 → 22.** Low risk; vite 6 and Playwright both support it.
- **First devcontainer rebuild is slow.** The `dev` image gains Playwright
  Chromium plus roughly 180 MB of `node_modules`. Subsequent creates are much
  faster since nothing is apt-installed at create time.
- **Stale `node_modules` volumes** after a dependency change, mitigated by the
  `on-create.sh` self-heal and documented `docker volume rm` escape hatch.

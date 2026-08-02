#!/bin/bash
# Runs once, when the devcontainer is created.
#
# Everything that CAN be baked into an image is baked into the Dockerfile's `dev`
# stage — git, git-lfs, jq, vim, fzf, ripgrep, fd, bat, node/npm, Playwright
# Chromium, GitHub host keys. This script only handles what depends on the
# running container or on host mounts.
set -e

# Nothing below needs root: this container runs as the non-root app-user, and
# both the node_modules volumes and $HOME are owned by it. Should a root-ish
# chore be needed later, the `dev` image stage provides passwordless sudo — guard
# it (`[ "$(id -u)" -ne 0 ] && command -v sudo`) so this still works as root.

# Reconcile node_modules. The named volumes are seeded from the image on first
# create, but they persist across container rebuilds, so a package.json change
# made since the volume was created would otherwise go unnoticed. Both commands
# are fast no-ops when already in sync.
(cd /workspace/frontend && npm install)
/workspace/frontend/util/install-plugins

# Claude config hydration, if the personal (gitignored) compose override mounts
# it. $HOME/.claude cannot be bind-mounted in place: plugin manifests embed
# absolute host paths the loader can't resolve inside the container
# (claude-code#31388), so copy and rewrite the paths instead.
if [ -d /host/home/.claude ]; then
    mkdir -p "$HOME/.claude"
    for d in agents plugins skills; do
        if [ -d "/host/home/.claude/$d" ]; then
            rm -rf "$HOME/.claude/$d"
            cp -r "/host/home/.claude/$d" "$HOME/.claude/$d"
        fi
    done

    # installed_plugins.json holds each plugin's `installPath`;
    # known_marketplaces.json holds the marketplace `installLocation` the loader
    # reads plugin manifests from. Both need the host path rewritten to $HOME.
    for f in installed_plugins.json known_marketplaces.json; do
        if [ -f "$HOME/.claude/plugins/$f" ]; then
            sed -i -E "s|/home/[^/]+/\.claude/|$HOME/.claude/|g" \
                "$HOME/.claude/plugins/$f"
        fi
    done
fi

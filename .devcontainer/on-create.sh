#!/bin/bash
set -e

# Fix permissions issue when trying to update
chmod 1777 /tmp
apt update
apt install -y \
    git \
    git-lfs \
    fzf \
    jq \
    vim

if [ -d /host/.claude ]; then
    mkdir -p /root/.claude
    for d in agents plugins skills; do
        if [ -d "/host/.claude/$d" ]; then
            rm -rf "/root/.claude/$d"
            cp -r "/host/.claude/$d" "/root/.claude/$d"
        fi
    done

    # Rewrite host-specific paths so the plugin loader resolves them inside the
    # container. installed_plugins.json holds each plugin's `installPath`;
    # known_marketplaces.json holds the marketplace `installLocation` the
    # loader reads plugin manifests from.
    for f in installed_plugins.json known_marketplaces.json; do
        if [ -f "/root/.claude/plugins/$f" ]; then
            sed -i -E 's|/home/[^/]+/\.claude/|/root/.claude/|g' \
                "/root/.claude/plugins/$f"
        fi
    done
fi

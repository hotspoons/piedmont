#!/usr/bin/env bash
# opencode (the coding agent) and OpenChamber (its VS Code UI) for this container. Runs as the
# onCreateCommand, i.e. BEFORE the editor connects and OpenChamber starts — post-create.sh runs after
# that and can take an hour, too late for an extension that looks for the binary on activation.
# Idempotent: safe to re-run by hand (bash .devcontainer/opencode.sh).
#
# Everything opencode and OpenChamber keep lives in .devhome/ in this checkout (gitignored), which a
# rebuild does not touch: the binary, config, auth, sessions, state, caches and OpenChamber's settings.
# devcontainer.json bind-mounts each .devhome/<path> onto ~/<path> (the list below), so
# .devhome/.config/opencode IS ~/.config/opencode.
#
# Bind mounts, not symlinks: OpenCode 2 watches its config and skill directories with inotify and will
# not watch through a symlink ("inotify_add_watch ... Not a directory"), so edits would stop applying
# live. And the checkout's .devhome, not the host's own ~/.config and ~/.local/share/opencode: a host
# opencode sharing one SQLite database with the container's (across the VM boundary on macOS) is what
# filled ~/.local/share/opencode/brokendbs, and OpenCode 2 migrates that database in place, which
# would break a 1.x opencode on the host.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# keep in step with "mounts" and "initializeCommand" in devcontainer.json
PERSIST=(
    .opencode               # the binary (~/.opencode/bin): the installer, `opencode upgrade` and OpenChamber's one-click install
    .config/opencode        # opencode.json, plugins
    .local/share/opencode   # opencode.db (sessions), auth.json, logs, snapshots
    .local/state/opencode   # prompt history, last model, the background service's state
    .cache/opencode         # downloaded tools and skills
    .config/openchamber     # OpenChamber's settings and per-project state
    .agents                 # skills OpenChamber installs (~/.agents/skills)
)

for p in "${PERSIST[@]}"; do
    # Docker makes every missing parent of a mount target root-owned (~/.local, ~/.local/share,
    # ~/.local/state, ~/.cache), and opencode cannot even print its version without writing beside
    # its own directories there. The parents only, never -R: below them are the mounts.
    d=$(dirname "$HOME/$p")
    while [ "$d" != "$HOME" ]; do
        [ -d "$d" ] && [ ! -w "$d" ] && sudo chown "$(id -u):$(id -g)" "$d"
        d=$(dirname "$d")
    done
    mountpoint -q "$HOME/$p" \
        || echo "WARN: ~/$p is not mounted from .devhome/$p — it will not survive a rebuild (devcontainer.json \"mounts\")"
done

# OpenChamber >= 2.0 runs on OpenCode 2 only, and refuses 1.x with an "update" screen. OpenCode 2 is
# its own channel (opencode.ai/v2/install, the @opencode/cli packages); opencode.ai/install is still 1.x.
# The binary persists in .devhome, so this downloads only on the first container, or when what is there
# is not 2.x or does not run here (another architecture). Upgrades: `opencode upgrade`.
OPENCODE="$HOME/.opencode/bin/opencode"
case "$("$OPENCODE" --version 2>/dev/null || true)" in
    *v2.*) ;;
    *) (curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path) \
        || echo "WARN: opencode install failed — re-run: bash .devcontainer/opencode.sh" ;;
esac

# On PATH for every process, not just interactive shells: OpenChamber starts opencode from the
# extension host, which never reads ~/.bashrc. A link, so `opencode upgrade` (which replaces the
# binary in ~/.opencode/bin) needs no follow-up.
if [ -x "$OPENCODE" ]; then
    sudo ln -sfn "$OPENCODE" /usr/local/bin/opencode
    echo "opencode $("$OPENCODE" --version 2>/dev/null | awk '{print $NF}'), state in $ROOT/.devhome"
fi

#!/usr/bin/env bash
# Deploy pigeon main to THIS machine's running pigeon-daemon.
#
#   scripts/deploy-daemon.sh            # pull, install, restart, verify
#   scripts/deploy-daemon.sh --dry-run  # resolve + preflight only; changes nothing
#
# Everything is derived from the running service definition, not from this
# script's location or the caller's PATH:
#   - the repo  = the checkout whose node_modules/tsx the service runs
#   - the node  = the node binary the service execs
# so it can be run from a worktree and still acts on the production checkout.
#
# Why the node matters: packages/daemon depends on better-sqlite3, a NATIVE
# module. `npm install` builds/fetches it for whichever `node` is first on PATH.
# Built under a different major than the service's node, the daemon dies on
# restart with NODE_MODULE_VERSION mismatch. An opencode bash call often has no
# npm on PATH at all (macOS: direnv/devenv not loaded), which is the benign
# version of the same problem.
#
# Never stashes, resets or cleans: the checkout is production and may hold a
# peer's work. Any surprise is a refusal with a reason.
#
# Overrides (only if resolution fails on an unusual host):
#   PIGEON_DAEMON_NODE_DIR  directory containing the service's node and npm
#   PIGEON_DAEMON_REPO      the checkout the service runs
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run|-n) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

die() { echo "deploy-daemon: ERROR: $*" >&2; exit 1; }
say() { echo "deploy-daemon: $*"; }

HEALTH_URL="http://127.0.0.1:4731/health"
LAUNCHD_LABEL="org.nix-community.home.pigeon-daemon"
UNIT="pigeon-daemon.service"

# --- 1. Find the service and the text that launches it -----------------------
launcher=""
case "$(uname -s)" in
  Darwin)
    MANAGER=launchd
    plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
    [ -f "$plist" ] || die "no launchd agent at $plist"
    # ProgramArguments is ["/bin/sh","-c","<script>"]; the script holds the exec.
    launcher="$(plutil -extract ProgramArguments.2 raw -o - "$plist")" \
      || die "cannot read ProgramArguments from $plist"
    restart_cmd=(launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL")
    log_hint="tail -50 ~/Library/Logs/pigeon-daemon.err.log"
    ;;
  Linux)
    MANAGER=systemd
    # devbox/cloudbox: system unit (restart needs sudo). chromebook: user unit.
    if [ "$(systemctl show "$UNIT" -p LoadState --value 2>/dev/null)" = loaded ]; then
      sc=(systemctl); restart_cmd=(sudo systemctl restart "$UNIT")
      log_hint="journalctl --namespace=pigeon -u $UNIT -n 50 --no-pager"
    elif [ "$(systemctl --user show "$UNIT" -p LoadState --value 2>/dev/null)" = loaded ]; then
      sc=(systemctl --user); restart_cmd=(systemctl --user restart "$UNIT")
      log_hint="journalctl --user -u $UNIT -n 50 --no-pager"
    else
      die "$UNIT is not loaded as a system or user unit"
    fi
    # ExecStart on NixOS is a generated wrapper script whose text holds the
    # exec line; read both the ExecStart line and that script.
    exec_line="$("${sc[@]}" show "$UNIT" -p ExecStart --value)"
    exec_path="$(printf '%s\n' "$exec_line" | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -1)"
    [ -n "$exec_path" ] || die "cannot read ExecStart of $UNIT"
    launcher="$exec_line
$(grep -a -e /bin/node -e node_modules/tsx "$exec_path" 2>/dev/null || true)"
    ;;
  *) die "unsupported OS $(uname -s)" ;;
esac

# --- 2. Derive the node and the repo from the launcher -----------------------
if [ -n "${PIGEON_DAEMON_NODE_DIR:-}" ]; then
  NODE_DIR="$PIGEON_DAEMON_NODE_DIR"
else
  node_bin="$(printf '%s\n' "$launcher" | grep -oE "/[^ \"']*/bin/node([ \"']|$)" \
    | head -1 | sed -E "s/[ \"']$//")"
  [ -n "$node_bin" ] || die "cannot find the node binary in the service's launcher (set PIGEON_DAEMON_NODE_DIR)"
  NODE_DIR="$(dirname "$node_bin")"
fi
[ -x "$NODE_DIR/node" ] || die "$NODE_DIR/node is not executable"
[ -x "$NODE_DIR/npm" ]  || die "$NODE_DIR/npm is not executable (no npm beside the service's node)"

if [ -n "${PIGEON_DAEMON_REPO:-}" ]; then
  REPO="$PIGEON_DAEMON_REPO"
else
  tsx="$(printf '%s\n' "$launcher" | grep -oE "/[^ \"']*/node_modules/tsx/" | head -1)"
  [ -n "$tsx" ] || die "cannot find the repo (node_modules/tsx) in the service's launcher (set PIGEON_DAEMON_REPO)"
  REPO="${tsx%/node_modules/tsx/}"
fi
[ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || die "$REPO is not a git checkout"

say "service:  $MANAGER"
say "repo:     $REPO"
say "node:     $NODE_DIR/node ($("$NODE_DIR/node" -v), ABI $("$NODE_DIR/node" -p process.versions.modules))"

# Runs node/npm exactly as the service would see them. PATH is prefixed, not
# just the binary named, because better-sqlite3's install scripts call `node`.
with_node() { PATH="$NODE_DIR:$PATH" "$@"; }
sqlite_check() {
  (cd "$REPO/packages/daemon" && with_node node -e \
    'new (require("better-sqlite3"))(":memory:").close()')
}

# --- 3. Preflight (read-only) -------------------------------------------------
g() { git -C "$REPO" "$@"; }
branch="$(g rev-parse --abbrev-ref HEAD)"
[ "$branch" = main ] || die "$REPO is on '$branch', not main; refusing to deploy"
dirty="$(g status --porcelain --untracked-files=no)"
[ -z "$dirty" ] || die "$REPO has tracked changes (someone's unreviewed edits to prod):
$dirty
Move them to a worktree (see AGENTS.md); do NOT stash/reset/clean the root."

if [ "$DRY_RUN" = 1 ]; then
  ahead="$(g rev-list --count '@{u}..HEAD')"
  behind="$(g rev-list --count 'HEAD..@{u}')"
  say "HEAD:     $(g rev-parse --short HEAD) (vs last-fetched upstream: ahead $ahead, behind $behind; not fetched)"
  if sqlite_check 2>/dev/null; then
    say "better-sqlite3 currently loads under the service's node"
  else
    say "WARNING: better-sqlite3 does NOT load under the service's node right now"
  fi
  say "dry run; would run:"
  say "  git -C $REPO pull --ff-only"
  say "  (cd $REPO && PATH=$NODE_DIR:\$PATH npm install --no-audit --no-fund)"
  say "  better-sqlite3 load check under $NODE_DIR/node"
  say "  ${restart_cmd[*]}"
  say "  poll $HEALTH_URL"
  exit 0
fi

g fetch --quiet origin
ahead="$(g rev-list --count '@{u}..HEAD')"
[ "$ahead" = 0 ] || die "$REPO main has $ahead commit(s) on no remote; they would be deployed unreviewed. Rescue them to a branch first."

# --- 4. Pull, install, check --------------------------------------------------
before="$(g rev-parse --short HEAD)"
g pull --ff-only --quiet
after="$(g rev-parse --short HEAD)"
say "pulled:   $before -> $after"

(cd "$REPO" && with_node npm install --no-audit --no-fund)

# Gate the restart on the native module loading under the service's node. The
# running daemon already has its copy loaded, so failing here leaves it up.
sqlite_check || die "better-sqlite3 does not load under $NODE_DIR/node after install; NOT restarting (the running daemon is unaffected)"

# --- 5. Restart and verify ----------------------------------------------------
say "restarting: ${restart_cmd[*]}"
"${restart_cmd[@]}"

for _ in $(seq 1 30); do
  if curl -s --max-time 2 "$HEALTH_URL" | grep -q '"ok":true'; then
    say "healthy at $after: $(curl -s --max-time 2 "$HEALTH_URL")"
    exit 0
  fi
  sleep 2
done
die "daemon not healthy 60s after restart. Logs: $log_hint"

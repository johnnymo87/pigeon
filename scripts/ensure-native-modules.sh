#!/usr/bin/env bash
# Make sure better-sqlite3 in node_modules loads under a given node, rebuilding
# it once if it does not.
#
#   scripts/ensure-native-modules.sh --node-dir DIR [--repo DIR]
#       [--build-path PATH] [--check-only] [--latch FILE] [--alarm]
#
#   --node-dir DIR  directory holding the node (and npm) the daemon runs under
#   --repo DIR      the pigeon checkout (default: the one this script is in)
#   --build-path P  colon-separated dirs prepended to PATH for the rebuild only:
#                   python3, make and a C++ compiler for node-gyp, which a
#                   service's PATH does not have. There is often no prebuilt
#                   binary to download (none for node 24.22.3 linux-arm64 and
#                   better-sqlite3 11.10.0), so the rebuild compiles.
#   --check-only    report only; never rebuild
#   --latch FILE    remember a failed rebuild in FILE, and do not retry it while
#                   the node and better-sqlite3 versions are unchanged
#   --alarm         when a rebuild fails, post once to
#                   $PIGEON_SLACK_ALARM_WEBHOOK_URL (if set)
#
# Exit 0: it loads (possibly after a rebuild). 1: it does not. 2: usage.
#
# Why: packages/daemon depends on better-sqlite3, a NATIVE module, built for one
# node ABI. When the service's node changes under it -- a NixOS, home-manager or
# nix-darwin switch that bumps nodejs, or an `npm install` run under a different
# node -- the daemon dies at start with ERR_DLOPEN_FAILED / NODE_MODULE_VERSION
# mismatch and restarts forever (cloudbox, 2026-11-25: 54 restarts). `npm
# install` does not fix it: it does not re-run install scripts for an unchanged
# package. Only `npm rebuild better-sqlite3` under the service's node does.
#
# Two callers:
#   - scripts/deploy-daemon.sh, before it restarts the daemon;
#   - the daemon's start script on every machine (workstation repo:
#     hosts/{cloudbox,devbox}/configuration.nix, users/dev/home.darwin.nix),
#     with --latch and --alarm, before it execs the daemon.
# The check costs one node start (~0.1s), so it is cheap enough for every start.
#
# The latch is what keeps a rebuild that cannot succeed (no network for the
# prebuilt binary, no compiler for the fallback) from being re-run on every
# automatic restart. Once latched, each start fails fast and says how to fix it;
# fixing node_modules by hand clears the latch, and so does a different node or
# better-sqlite3 version, which earns one fresh attempt.
#
# Must run under macOS's bash 3.2, and with only bash, coreutils and node on
# PATH (the systemd units' PATH): no grep, sed or curl.
set -euo pipefail

NODE_DIR=""
REPO=""
BUILD_PATH=""
CHECK_ONLY=0
LATCH=""
ALARM=0
usage() { echo "usage: $0 --node-dir DIR [--repo DIR] [--check-only] [--latch FILE] [--alarm]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --node-dir) [ $# -ge 2 ] || usage; NODE_DIR="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    --build-path) [ $# -ge 2 ] || usage; BUILD_PATH="$2"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --latch) [ $# -ge 2 ] || usage; LATCH="$2"; shift 2 ;;
    --alarm) ALARM=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$NODE_DIR" ] || usage
[ -x "$NODE_DIR/node" ] || { echo "ensure-native-modules: $NODE_DIR/node is not executable" >&2; exit 2; }
[ -n "$REPO" ] || REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$REPO/packages/daemon" ] || { echo "ensure-native-modules: $REPO/packages/daemon not found" >&2; exit 2; }

say() { echo "ensure-native-modules: $*" >&2; }
# PATH is prefixed, not just the binary named: better-sqlite3's install scripts
# (prebuild-install, node-gyp) call `node` themselves.
with_node() { PATH="$NODE_DIR:$PATH" "$@"; }
HINT="(cd $REPO && PATH=$NODE_DIR:\$PATH npm rebuild better-sqlite3)"

# Resolved from packages/daemon, as the daemon resolves it. Sets LOAD_ERR.
loads() {
  LOAD_ERR="$(cd "$REPO/packages/daemon" && with_node node -e \
    'new (require("better-sqlite3"))(":memory:").close()' 2>&1 >/dev/null)" && return 0
  # The informative line, not the stack: first one naming the ABI, else the
  # first Error line, else the first line.
  local line first="" err=""
  while IFS= read -r line; do
    [ -n "$first" ] || first="$line"
    case "$line" in
      *NODE_MODULE_VERSION*) err="$line"; break ;;
      *Error*) [ -n "$err" ] || err="$line" ;;
    esac
  done <<<"$LOAD_ERR"
  LOAD_ERR="${err:-$first}"
  return 1
}
# What a failed rebuild is a failure FOR. A change in any of these earns a retry.
key() {
  (cd "$REPO/packages/daemon" && with_node node -p \
    'process.execPath+" "+process.version+" abi"+process.versions.modules+" better-sqlite3@"+(()=>{try{return require("better-sqlite3/package.json").version}catch(e){return "missing"}})()' \
    2>/dev/null) || echo unknown
}
clear_latch() { [ -z "$LATCH" ] || rm -f "$LATCH"; }

if loads; then
  clear_latch
  exit 0
fi
say "better-sqlite3 does not load under $NODE_DIR/node ($(with_node node -v)): $LOAD_ERR"
if [ "$CHECK_ONLY" = 1 ]; then
  say "fix: $HINT"
  exit 1
fi

k="$(key)"
latched=""
[ -z "$LATCH" ] || [ ! -f "$LATCH" ] || { read -r latched < "$LATCH" || true; }
if [ -n "$latched" ] && [ "$latched" = "$k" ]; then
  { read -r _; read -r when; } < "$LATCH" || true
  say "a rebuild for this node already failed (${when:-at an unknown time}); not retrying."
  say "fix: $HINT -- then restart the daemon. (Or delete $LATCH to retry automatically.)"
  exit 1
fi

say "rebuilding better-sqlite3 once: $HINT"
rebuild() {
  cd "$REPO"
  # Compile against the headers shipped with this node (nixpkgs' nodejs has
  # them), so node-gyp needs no download from nodejs.org.
  [ ! -f "$NODE_DIR/../include/node/node.h" ] || export npm_config_nodedir="$(cd "$NODE_DIR/.." && pwd)"
  # npm's stdout goes to stderr so a caller's stdout stays clean.
  PATH="$NODE_DIR${BUILD_PATH:+:$BUILD_PATH}:$PATH" npm rebuild better-sqlite3 >&2
}
if ! (rebuild); then
  why="npm rebuild better-sqlite3 failed (its output is above)"
elif loads; then
  say "rebuilt; better-sqlite3 loads under $(with_node node -v)"
  clear_latch
  exit 0
else
  why="it still does not load after a successful rebuild: $LOAD_ERR"
fi

say "FAILED: $why"
say "fix: $HINT"
if [ -n "$LATCH" ]; then
  mkdir -p "$(dirname "$LATCH")"
  printf '%s\n%s\n' "$k" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LATCH"
  say "latched in $LATCH: later starts fail fast until node_modules is fixed or node changes."
fi
if [ "$ALARM" = 1 ] && [ -n "${PIGEON_SLACK_ALARM_WEBHOOK_URL:-}" ]; then
  host="${CCR_MACHINE_ID:-$(uname -n)}"
  msg=":rotating_light: pigeon-daemon on *$host* cannot start: better-sqlite3 does not load under node $(with_node node -v), and \`npm rebuild better-sqlite3\` did not fix it. Fix on $host: \`$HINT\`, then restart the daemon."
  # node's fetch, so this needs no curl on the service's PATH. Best effort.
  with_node node -e '
    const ac = new AbortController(); setTimeout(() => ac.abort(), 10000).unref();
    fetch(process.env.PIGEON_SLACK_ALARM_WEBHOOK_URL, { method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ text: process.argv[1] }) })
      .then(r => { if (!r.ok) console.error("alarm post: HTTP " + r.status) },
            e => console.error("alarm post failed: " + e.message))' "$msg" >&2 || true
fi
exit 1

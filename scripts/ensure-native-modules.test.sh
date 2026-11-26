#!/usr/bin/env bash
# Tests for scripts/ensure-native-modules.sh, against a stub node and npm.
#
#   bash scripts/ensure-native-modules.test.sh
#
# The stubs stand in for a node whose better-sqlite3 does or does not load, and
# an npm whose `rebuild` does or does not fix it, so every branch runs in
# milliseconds without touching the real node_modules. The real thing is
# exercised by deploy-daemon.sh and by the daemon's start scripts.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/ensure-native-modules.sh"
pass=0
fail=0

# One sandbox per case: a fake repo, a fake node dir, and a state dir that
# the stubs read and write.
setup() {
  T="$(mktemp -d)"
  mkdir -p "$T/repo/packages/daemon" "$T/bin" "$T/state" "$T/sys" "$T/tools"
  # The systemd units' PATH holds only bash, coreutils and node, so the script
  # under test gets exactly that: a missing grep/sed fails here, not in prod.
  for t in bash env cat head date mkdir rm dirname uname touch; do
    ln -s "$(command -v "$t")" "$T/sys/$t"
  done
  # node: `-e CODE` loads better-sqlite3 (or posts the alarm); `-p EXPR`
  # prints the latch key fields.
  cat > "$T/bin/node" <<EOF
#!/usr/bin/env bash
S="$T/state"
case "\$1" in
  -v) cat "\$S/version" 2>/dev/null || echo v24.0.0; exit 0 ;;
  -p) echo "\$(cat "\$S/version" 2>/dev/null || echo v24.0.0) abi137 better-sqlite3@12.0.0"; exit 0 ;;
  -e)
    case "\$2" in
      *fetch*) printf '%s\n' "\$3" >> "\$S/alarms"; exit 0 ;;
      *better-sqlite3*)
        echo "\$PWD" > "\$S/check_cwd"
        [ -e "\$S/loads" ] && exit 0
        echo "Error: The module was compiled against a different Node.js version (NODE_MODULE_VERSION 127)" >&2
        exit 1 ;;
    esac ;;
esac
echo "stub node: unexpected args: \$*" >&2; exit 99
EOF
  # npm: records each call; `rebuild` fixes the binary iff rebuild_ok exists.
  cat > "$T/bin/npm" <<EOF
#!/usr/bin/env bash
S="$T/state"
echo "\$* | cwd=\$PWD | node=\$(command -v node) | PATH=\$PATH | nodedir=\${npm_config_nodedir:-}" >> "\$S/npm_calls"
[ "\$1" = rebuild ] || exit 98
[ -e "\$S/rebuild_noop" ] && exit 0
[ -e "\$S/rebuild_ok" ] || { echo "gyp ERR! build error" >&2; exit 1; }
touch "\$S/loads"
EOF
  chmod +x "$T/bin/node" "$T/bin/npm"
  LATCH="$T/state/latch"
}
teardown() { rm -rf "$T"; }

# run ARGS...: runs the script under test, capturing rc and combined output.
run() {
  set +e
  out="$(env -u PIGEON_SLACK_ALARM_WEBHOOK_URL ${WEBHOOK:+PIGEON_SLACK_ALARM_WEBHOOK_URL="$WEBHOOK"} \
    PATH="$T/sys" bash "$SUT" --node-dir "$T/bin" --repo "$T/repo" "$@" 2>&1)"
  rc=$?
  set -e
}
npm_calls() { [ -f "$T/state/npm_calls" ] && wc -l < "$T/state/npm_calls" | tr -d ' ' || echo 0; }
alarms() { [ -f "$T/state/alarms" ] && wc -l < "$T/state/alarms" | tr -d ' ' || echo 0; }

check() { # check NAME CONDITION...
  local name="$1"; shift
  if "$@"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $name"; echo "  rc=$rc"; printf '%s\n' "$out" | sed 's/^/  | /'; fi
}
is() { [ "$1" = "$2" ]; }
has() { grep -qF -- "$2" <<<"$1"; }

# 1. Nothing changed: exits 0 without calling npm.
setup; touch "$T/state/loads"
run --latch "$LATCH"
check "loads: rc 0" is "$rc" 0
check "loads: no npm" is "$(npm_calls)" 0
check "loads: checked from packages/daemon" is "$(cat "$T/state/check_cwd")" "$T/repo/packages/daemon"
teardown

# 2. ABI mismatch that a rebuild fixes: one rebuild, under the given node.
setup; touch "$T/state/rebuild_ok"
run --latch "$LATCH"
check "fixable: rc 0" is "$rc" 0
check "fixable: one npm call" is "$(npm_calls)" 1
check "fixable: npm rebuild better-sqlite3" has "$(cat "$T/state/npm_calls")" "rebuild better-sqlite3 | cwd=$T/repo |"
check "fixable: npm saw the service's node first on PATH" has "$(cat "$T/state/npm_calls")" "node=$T/bin/node"
check "fixable: says why it rebuilt" has "$out" "NODE_MODULE_VERSION 127"
check "fixable: no latch left" test ! -e "$LATCH"
teardown

# 2b. --build-path reaches the rebuild; the node's own headers are used.
setup; touch "$T/state/rebuild_ok"; mkdir -p "$T/include/node"; touch "$T/include/node/node.h"
run --build-path "$T/tools:/nowhere"
check "build-path: rc 0" is "$rc" 0
check "build-path: on npm's PATH after node" has "$(cat "$T/state/npm_calls")" "PATH=$T/bin:$T/tools:/nowhere:"
check "build-path: nodedir is the node's prefix" has "$(cat "$T/state/npm_calls")" "nodedir=$T"
teardown

# 3. Rebuild fails: exit 1, latch written, alarm sent once.
setup; WEBHOOK="https://example.invalid/hook"
run --latch "$LATCH" --alarm
check "broken: rc 1" is "$rc" 1
check "broken: one rebuild attempt" is "$(npm_calls)" 1
check "broken: latch written" test -s "$LATCH"
check "broken: one alarm" is "$(alarms)" 1
check "broken: names the fix" has "$out" "npm rebuild better-sqlite3"
check "broken: names the latch" has "$out" "$LATCH"

# 4. Next start, same node: no second rebuild, no second alarm, still exit 1.
run --latch "$LATCH" --alarm
check "latched: rc 1" is "$rc" 1
check "latched: no new rebuild" is "$(npm_calls)" 1
check "latched: no new alarm" is "$(alarms)" 1
check "latched: says it is not retrying" has "$out" "not retrying"

# 5. Node changed again: the latch no longer matches, so it retries.
echo v24.1.0 > "$T/state/version"; touch "$T/state/rebuild_ok"
run --latch "$LATCH" --alarm
check "new node: rc 0" is "$rc" 0
check "new node: retried" is "$(npm_calls)" 2
check "new node: latch cleared" test ! -e "$LATCH"
teardown; WEBHOOK=""

# 5b. npm exits 0 but the binary still does not load: also a failure.
setup; touch "$T/state/rebuild_noop"
run --latch "$LATCH"
check "noop rebuild: rc 1" is "$rc" 1
check "noop rebuild: says it still does not load" has "$out" "still does not load after a successful rebuild"
check "noop rebuild: latched" test -s "$LATCH"
teardown

# 6. Latched, then fixed by hand: loads, so exit 0 and the latch is cleared.
setup; WEBHOOK=""
run --latch "$LATCH"
check "manual fix: first run latched" test -s "$LATCH"
touch "$T/state/loads"
run --latch "$LATCH"
check "manual fix: rc 0" is "$rc" 0
check "manual fix: latch cleared" test ! -e "$LATCH"
check "manual fix: no second rebuild" is "$(npm_calls)" 1
teardown

# 7. --check-only never rebuilds.
setup
run --check-only
check "check-only: rc 1" is "$rc" 1
check "check-only: no npm" is "$(npm_calls)" 0
teardown

# 8. --alarm without a webhook: no alarm, failure still reported.
setup
run --latch "$LATCH" --alarm
check "no webhook: rc 1" is "$rc" 1
check "no webhook: no alarm" is "$(alarms)" 0
teardown

# 9. Without --latch every failing call retries (deploy-daemon.sh's use).
setup
run; run
check "no latch: retries each call" is "$(npm_calls)" 2
teardown

# 10. Usage errors exit 2.
setup
set +e; out="$(bash "$SUT" 2>&1)"; rc=$?; set -e
check "usage: no --node-dir is rc 2" is "$rc" 2
set +e; out="$(bash "$SUT" --node-dir "$T/nope" --repo "$T/repo" 2>&1)"; rc=$?; set -e
check "usage: missing node is rc 2" is "$rc" 2
teardown

echo "ensure-native-modules: $pass passed, $fail failed"
[ "$fail" = 0 ]

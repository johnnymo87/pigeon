#!/usr/bin/env bash
# END-TO-END proof for the pigeon-side registry endpoint fence (bead pigeon-13p).
#
# Runs the REAL daemon entrypoint (src/index.ts, i.e. the index.ts wiring that no
# unit test covers) against a SCRATCH DB on a SCRATCH port, hijacks a pool slot's
# endpoint exactly the way the 2026-07-25 throwaway serve did, and asserts the
# daemon repairs it on its own within one poll interval.
#
# SAFETY:
#  - PIGEON_DAEMON_DB_PATH points at /tmp, never the live pigeon-daemon.db.
#  - PIGEON_DAEMON_PORT is 4739, not the live 4731.
#  - No CCR_* vars, so the worker poller never starts and nothing registers.
#  - PIGEON_SERVE_ENDPOINTS lists ports nothing is listening on, and
#    PIGEON_SERVE_LIVENESS=self so the daemon never HTTP-probes them.
#  - TELEGRAM_BOT_TOKEN is deliberately bogus, so the alert path is exercised for
#    real but Telegram rejects it instead of paging a human.
set -uo pipefail

WT=/home/dev/projects/pigeon/.worktrees/registry-fencing
DIR=/tmp/opencode/e2e
DB=$DIR/scratch-daemon.db
LOG=$DIR/daemon.log
PORT=4739
POLL_MS=1000

rm -rf "$DIR"; mkdir -p "$DIR"

sqlite() { node -e '
const D=require("better-sqlite3");const db=new D(process.argv[1]);
const out=db.prepare(process.argv[2]).all();
console.log(JSON.stringify(out));' "$DB" "$1"; }

run_sql() { node -e '
const D=require("better-sqlite3");const db=new D(process.argv[1]);
db.prepare(process.argv[2]).run();' "$DB" "$1"; }

echo "### 1. Boot the real daemon entrypoint against the scratch DB"
env -u OPENCODE_SERVE_ID -u OPENCODE_ROUTING_DB -u OPENCODE_DB \
    -u OPENCODE_SESSION_ID -u OPENCODE_DISABLE_CHANNEL_DB \
    PIGEON_DAEMON_DB_PATH="$DB" \
    PIGEON_DAEMON_PORT="$PORT" \
    PIGEON_SERVE_ENDPOINTS="http://127.0.0.1:34096,http://127.0.0.1:34097" \
    PIGEON_SERVE_LIVENESS=self \
    PIGEON_HEALTH_POLL_MS="$POLL_MS" \
    TELEGRAM_BOT_TOKEN="000000:bogus-token-for-e2e" \
    TELEGRAM_CHAT_ID="-1000000000000" \
    CCR_MACHINE_ID="" \
  setsid nohup node /home/dev/projects/pigeon/node_modules/tsx/dist/cli.mjs "$WT/packages/daemon/src/index.ts" \
  < /dev/null > "$LOG" 2>&1 &
DAEMON_PID=$!
cleanup() { kill -TERM "$DAEMON_PID" 2>/dev/null; sleep 0.5; kill -9 "$DAEMON_PID" 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 60); do
  ss -tln 2>/dev/null | grep -q "127.0.0.1:$PORT " && break
  sleep 0.25
done
ss -tln 2>/dev/null | grep -q "127.0.0.1:$PORT " || { echo "DAEMON DID NOT START"; cat "$LOG"; exit 1; }

echo "--- startup lines proving the reconciler is wired and knows its alert channel:"
grep -E "endpoint reconciler|ingress router" "$LOG"
echo

echo "### 2. Registry state as seeded (this is the healthy baseline)"
sqlite "SELECT serve_id, endpoint, instance_uuid, health_state, heartbeat_at, binary_epoch, draining FROM serve_instance ORDER BY serve_id"
echo

echo "### 3. Simulate the incident: a rogue process claims slot serve-1."
echo "    Exactly what registerSelf's ON CONFLICT DO UPDATE did on 2026-07-25:"
echo "    rewrites BOTH endpoint and instance_uuid, leaves the row healthy+non-draining."
run_sql "UPDATE serve_instance SET endpoint='http://127.0.0.1:47037', instance_uuid='688b827e-rogue-hijacker', health_state='healthy', heartbeat_at=$(date +%s%3N), draining=0 WHERE serve_id='serve-1'"
sqlite "SELECT serve_id, endpoint, instance_uuid FROM serve_instance WHERE serve_id='serve-1'"
echo

echo "### 4. Do nothing. Wait for the daemon to notice and self-heal."
REPAIRED=""
for i in $(seq 1 40); do
  sleep 0.25
  ep=$(node -e '
const D=require("better-sqlite3");const db=new D(process.argv[1]);
const r=db.prepare("SELECT endpoint FROM serve_instance WHERE serve_id=?").get("serve-1");
process.stdout.write(r ? r.endpoint : "");' "$DB")
  if [ "$ep" = "http://127.0.0.1:34097" ]; then REPAIRED="yes (after ~$((i*250))ms)"; break; fi
done

# The alert is an awaited network call to api.telegram.org; give it a bounded
# window to land rather than racing it (an unbounded assume-it-happened here
# would be exactly the vacuous check this exercise is guarding against).
for i in $(seq 1 60); do
  grep -q "drift alert" "$LOG" && break
  sleep 0.25
done

echo "--- daemon log during the repair:"
grep -E "endpoint-reconciler" "$LOG" | tail -6
echo
echo "--- final registry row for serve-1:"
sqlite "SELECT serve_id, endpoint, instance_uuid, health_state, binary_epoch, draining FROM serve_instance WHERE serve_id='serve-1'"
echo

echo "======================= ASSERTIONS ======================="
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"$'\n'"          expected: $3"$'\n'"          actual:   $2"; fail=$((fail+1)); fi; }

# NOTE: an earlier version of this line was `chk "..." "$REPAIRED" "$REPAIRED"`,
# which compared a value to itself and could never fail. Fixed to assert the
# observed endpoint against the CONFIGURED constant.
final_ep=$(node -e '
const D=require("better-sqlite3");const db=new D(process.argv[1]);
process.stdout.write(db.prepare("SELECT endpoint FROM serve_instance WHERE serve_id=?").get("serve-1").endpoint);' "$DB")
chk "endpoint self-healed to the CONFIGURED value" "$final_ep" "http://127.0.0.1:34097"
[ -n "$REPAIRED" ] && echo "        repair latency: $REPAIRED"

uuid=$(node -e '
const D=require("better-sqlite3");const db=new D(process.argv[1]);
process.stdout.write(db.prepare("SELECT instance_uuid FROM serve_instance WHERE serve_id=?").get("serve-1").instance_uuid);' "$DB")
chk "instance_uuid left ALONE (pigeon must never rewrite it)" "$uuid" "688b827e-rogue-hijacker"

ep0=$(node -e '
const D=require("better-sqlite3");const db=new D(process.argv[1]);
process.stdout.write(db.prepare("SELECT endpoint FROM serve_instance WHERE serve_id=?").get("serve-0").endpoint);' "$DB")
chk "undrifted slot serve-0 untouched" "$ep0" "http://127.0.0.1:34096"

if grep -q "serve endpoint drift repaired" "$LOG"; then
  echo "  PASS  drift was LOGGED (found + reassertedTo present)"; pass=$((pass+1))
else
  echo "  FAIL  drift was not logged"; fail=$((fail+1))
fi

if grep -q 'alertDelivery":"telegram"' "$LOG"; then
  echo "  PASS  startup line reports plain-alert delivery is AVAILABLE"; pass=$((pass+1))
else
  echo "  FAIL  startup line did not report an available alert channel"; fail=$((fail+1))
fi

if grep -q "drift alert send failed" "$LOG"; then
  echo "  PASS  alert was actually ATTEMPTED over the wire (bogus token -> rejected,"
  echo "        which also proves the repair survives a failing alert)"; pass=$((pass+1))
else
  echo "  FAIL  no evidence the alert was attempted"; fail=$((fail+1))
fi

echo "=========================================================="
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]

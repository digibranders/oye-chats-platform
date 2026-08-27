#!/usr/bin/env bash
# Launch the two-arm soak against the split-topology rig.
#
# WHY THIS EXISTS
#   The first 24h soak was started from an ad-hoc shell. Its BASE_URL, keys and
#   flags lived only in that shell's environment, so when the shell was gone the
#   run could not be inspected, reproduced, or corrected without reverse
#   engineering it out of `ps`. It also silently ran with two defects that made
#   the HTTP arm worthless (below). Both are now encoded here.
#
# THE TWO DEFECTS THIS SCRIPT EXISTS TO PREVENT
#   1. Shared client IP. Every VU used the driver's single address, so SlowAPI's
#      per-(bot_key, IP) limit on /chat/stream (30/min) became the binding
#      constraint: 9,861 429s against 1,800 200s in one measured hour, the 1,800
#      being exactly the 30/min ceiling. scenarios/soak.js now sends a per-VU
#      X-Forwarded-For; this script verifies that before launching.
#   2. Worker recycling left on. gunicorn's max_requests (10,000 +/- 1,000)
#      retires workers on its own schedule, resetting the RSS and descriptor
#      counters a soak exists to watch. A leak is erased about hourly and cannot
#      surface. This script pins GUNICORN_MAX_REQUESTS=0 on both units first.
set -euo pipefail

APP_HOST="${APP_HOST:-192.168.252.2}"
API_PORT="${API_PORT:-8001}"      # oye-loadapi, 4 workers
WS_PORT="${WS_PORT:-8002}"        # oye-loadws,  1 worker (sockets)
DURATION="${DURATION:-24h}"
HTTP_VUS="${HTTP_VUS:-12}"
WS_CONNS="${WS_CONNS:-200}"
WS_CHURN="${WS_CHURN:-50}"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/oye_loadvm}"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no
          -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o LogLevel=ERROR)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$ROOT/results/soak_$STAMP"
mkdir -p "$OUT"

# Deterministic seeded credentials (datasets/seed_fixtures.py). Not secrets:
# they exist only in the throwaway oyechats_loadtest database on the rig.
export BASE_URL="http://$APP_HOST:$API_PORT"
export BOT_KEY="${BOT_KEY:-bot-loadtest-000000}"
export API_KEY="${API_KEY:-lt_admin_key_deterministic_0001}"
export OPERATOR_KEY="${OPERATOR_KEY:-lt_operator_key_deterministic_0001}"
export TEST_ENV=local
export MOCK_LLM_VERIFIED=1        # the rig points LiteLLM at the local mock

# --- preflight 1: the scenario must vary the client IP -----------------------
if ! grep -q "X-Forwarded-For" "$ROOT/scenarios/soak.js"; then
  echo "ABORT: scenarios/soak.js does not set X-Forwarded-For." >&2
  echo "       Every VU would share one IP and the run would measure SlowAPI's" >&2
  echo "       30/min per-(bot_key, IP) limit instead of the RAG path." >&2
  exit 1
fi

# --- preflight 2: turn off worker recycling on the rig ------------------------
echo "== disabling gunicorn worker recycling (leaks must survive to be seen) =="
timeout -k 5 90 ssh "${SSH_OPTS[@]}" "ubuntu@$APP_HOST" 'bash -s' <<'REMOTE'
set -e
for f in /etc/oye-loadapi.env /etc/oye-loadws.env; do
  sudo sed -i '/^GUNICORN_MAX_REQUESTS=/d' "$f"
  echo 'GUNICORN_MAX_REQUESTS=0' | sudo tee -a "$f" >/dev/null
done
# Redirect everything: without this the restarted units inherit the ssh
# session's stdout and the client never sees EOF, so the launcher hangs after
# having already done the work.
sudo systemctl restart oye-loadapi oye-loadws >/dev/null 2>&1 </dev/null
REMOTE
sleep 8
ssh "${SSH_OPTS[@]}" "ubuntu@$APP_HOST" \
  'echo "  api=$(systemctl is-active oye-loadapi) ws=$(systemctl is-active oye-loadws)"'

# --- server-side resource sampler --------------------------------------------
echo "== starting sampler =="
scp "${SSH_OPTS[@]}" "$HERE/soak-sampler.sh" "ubuntu@$APP_HOST:~/soak-sampler.sh" >/dev/null
SECS=$(python3 -c "
d='$DURATION'
n=int(''.join(c for c in d if c.isdigit()))
print(n*3600 if d.endswith('h') else n*60 if d.endswith('m') else n)")
# `timeout` and `-n`: starting a detached remote process can leave the ssh
# channel open even when the work succeeded, and a launcher that hangs after
# doing its job is worse than one that fails -- the first attempt at this left
# a sampler running while reporting nothing.
timeout -k 5 30 ssh -n "${SSH_OPTS[@]}" "ubuntu@$APP_HOST" \
  "chmod +x ~/soak-sampler.sh && setsid nohup env DB_HOST=192.168.252.3 \
   ~/soak-sampler.sh /home/ubuntu/soak_$STAMP.csv $SECS 60 >/dev/null 2>&1 </dev/null & echo started" || true

# Confirm it actually came up rather than trusting the call above.
if ! timeout -k 5 20 ssh -n "${SSH_OPTS[@]}" "ubuntu@$APP_HOST" \
     "test -f /home/ubuntu/soak_$STAMP.csv"; then
  echo "ABORT: sampler did not create /home/ubuntu/soak_$STAMP.csv" >&2
  exit 1
fi

# --- keep the host awake ------------------------------------------------------
# The first 24h attempt died at 8h47m. The Multipass VMs are guests of THIS Mac,
# so host sleep suspends the load generators and the servers under test at the
# same instant -- the k6 logs and the VM's own sampler both stopped within two
# minutes of each other, and neither wrote a summary. `caffeinate -dimsu` holds
# off display, idle, disk and system sleep for the run's duration; each k6 arm is
# launched under it so the assertion dies with the run rather than outliving it.
CAFFEINATE=(caffeinate -dimsu)
command -v caffeinate >/dev/null || CAFFEINATE=()   # non-macOS host: no-op

# --- the two arms -------------------------------------------------------------
echo "== launching soak: $DURATION, ${HTTP_VUS} http VUs, ${WS_CONNS}+${WS_CHURN} sockets =="
nohup "${CAFFEINATE[@]}" k6 run -e "DURATION=$DURATION" -e "VUS=$HTTP_VUS" -e CHAT=1 \
  --summary-export "$OUT/k6_http.json" "$ROOT/scenarios/soak.js" \
  >"$OUT/k6_http.log" 2>&1 &
disown

BASE_URL="http://$APP_HOST:$WS_PORT" \
nohup "${CAFFEINATE[@]}" k6 run -e "DURATION=$DURATION" -e "CONNS=$WS_CONNS" -e "CHURN_CONNS=$WS_CHURN" \
  --summary-export "$OUT/k6_ws.json" "$ROOT/scenarios/ws-soak.js" \
  >"$OUT/k6_ws.log" 2>&1 &
disown

cat >"$OUT/RUN.txt" <<EOF
started    $(date '+%F %T')
duration   $DURATION
http arm   $HTTP_VUS VUs -> $BASE_URL  (soak.js, per-VU X-Forwarded-For)
ws   arm   $WS_CONNS held + $WS_CHURN churning -> ws://$APP_HOST:$WS_PORT (ws-soak.js)
sampler    ubuntu@$APP_HOST:/home/ubuntu/soak_$STAMP.csv  (60s interval)
recycling  GUNICORN_MAX_REQUESTS=0 on oye-loadapi and oye-loadws
sleep      host held awake by caffeinate -dimsu for the duration
NOTE       a host reboot still ends the run; k6 is nohup'd, not a service
verdict    python3 runner/soak-verdict.py <sampler.csv> [$OUT/k6_ws.json]
EOF

echo
cat "$OUT/RUN.txt"
echo
echo "results -> $OUT"

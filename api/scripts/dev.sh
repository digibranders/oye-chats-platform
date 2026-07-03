#!/usr/bin/env bash
# Local backend dev stack: migrations → API + ARQ worker + webhook tunnel.
#
#   cd api && ./scripts/dev.sh
#
# Razorpay webhooks reach the local API via the account's static ngrok domain,
# so the dashboard webhook registration is one-time:
#   URL:    https://nuclei-rundown-okay.ngrok-free.dev/webhooks/razorpay
#   Secret: RAZORPAY_WEBHOOK_SECRET from api/.env
# If ngrok fails to establish (auth/network/outage), the script falls back to a
# cloudflared quick tunnel — that URL rotates per run, so the script prints it
# and the Razorpay dashboard URL must be updated for that session.
# Ctrl+C stops all processes.

set -euo pipefail
cd "$(dirname "$0")/.."

NGROK_DOMAIN="nuclei-rundown-okay.ngrok-free.dev"
PY=".venv/bin/python"
# WeasyPrint (invoice PDFs) needs homebrew pango on the dylib path.
export DYLD_FALLBACK_LIBRARY_PATH="${DYLD_FALLBACK_LIBRARY_PATH:-/opt/homebrew/lib}"

if [ ! -x "$PY" ]; then
  echo "error: $PY not found — run from api/ with the venv set up" >&2
  exit 1
fi

echo "==> alembic upgrade head (keeps dev DB in sync — skipping this breaks invoice writes)"
"$PY" -m alembic upgrade head

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "==> stopping dev stack"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# --- webhook tunnel: ngrok (static domain) with cloudflared fallback ---------
TUNNEL_URL=""

start_ngrok() {
  command -v ngrok >/dev/null || return 1
  echo "==> starting ngrok tunnel (https://${NGROK_DOMAIN} -> :8000)"
  ngrok http --url="https://${NGROK_DOMAIN}" 8000 --log=stdout --log-format=term > .ngrok.log 2>&1 &
  NGROK_PID=$!
  # ngrok's local API on :4040 reports the tunnel once it's actually up.
  for _ in $(seq 1 15); do
    kill -0 "$NGROK_PID" 2>/dev/null || break
    TUNNEL_URL=$(curl -sf --max-time 2 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
      | "$PY" -c "import json,sys; d=json.load(sys.stdin); print(d['tunnels'][0]['public_url'] if d.get('tunnels') else '')" 2>/dev/null) || TUNNEL_URL=""
    [ -n "$TUNNEL_URL" ] && { PIDS+=("$NGROK_PID"); return 0; }
    sleep 1
  done
  kill "$NGROK_PID" 2>/dev/null || true
  return 1
}

start_cloudflared() {
  command -v cloudflared >/dev/null || return 1
  echo "==> starting cloudflared quick tunnel (-> :8000)"
  cloudflared tunnel --url http://127.0.0.1:8000 > .cloudflared.log 2>&1 &
  CF_PID=$!
  for _ in $(seq 1 20); do
    kill -0 "$CF_PID" 2>/dev/null || break
    TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' .cloudflared.log | head -1)
    [ -n "$TUNNEL_URL" ] && { PIDS+=("$CF_PID"); return 0; }
    sleep 1
  done
  kill "$CF_PID" 2>/dev/null || true
  return 1
}

if start_ngrok; then
  TUNNEL_KIND="ngrok (static domain — Razorpay dashboard needs no update)"
elif start_cloudflared; then
  TUNNEL_KIND="cloudflared quick tunnel — URL ROTATES PER RUN"
  echo ""
  echo "    !! ngrok failed (see api/.ngrok.log) — using cloudflared instead."
  echo "    !! Update the Razorpay dashboard webhook URL for this session:"
  echo "    !!   ${TUNNEL_URL}/webhooks/razorpay"
  echo ""
else
  echo "    !! No tunnel established (ngrok + cloudflared both failed)." >&2
  echo "    !! Webhooks will NOT reach this machine; /verify fallbacks still work." >&2
  echo "    !! Logs: api/.ngrok.log, api/.cloudflared.log" >&2
  TUNNEL_KIND="NONE"
fi

echo "==> starting ARQ worker (invoice PDFs, emails, sweeps)"
"$PY" -m arq app.worker.settings.WorkerSettings &
PIDS+=($!)

echo "==> starting API on :8000 (reload)"
echo ""
echo "    Tunnel:               ${TUNNEL_KIND}"
[ -n "$TUNNEL_URL" ] && echo "    Razorpay webhook URL: ${TUNNEL_URL}/webhooks/razorpay"
echo ""
"$PY" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &
PIDS+=($!)

wait

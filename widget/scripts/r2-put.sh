#!/usr/bin/env bash
# Retry wrapper around `wrangler r2 object put`.
#
# Cloudflare's R2 API returns transient 503 "Service Unavailable" responses
# during regional degradation. Wrangler has no built-in retry, so under the
# deploy job's `set -euo pipefail` a single blip on any one object aborts the
# entire widget deploy — even though every other object uploaded fine. This
# wrapper retries each upload with exponential backoff so a passing deploy
# rides through short R2 hiccups instead of failing the whole pipeline.
#
# Usage: mirrors `wrangler r2 object put` — all args are forwarded verbatim:
#   bash scripts/r2-put.sh "$BUCKET/app/$base" --file="$file" --content-type=...
set -euo pipefail

max_attempts=6
delay=3
max_delay=30

attempt=1
while true; do
  # Run in a condition context so `set -e` doesn't abort on a failed attempt.
  if npx wrangler r2 object put "$@"; then
    exit 0
  fi
  status=$?
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "❌ wrangler r2 object put failed after ${max_attempts} attempts (exit ${status}): $*" >&2
    exit "$status"
  fi
  echo "⚠️  r2 put attempt ${attempt}/${max_attempts} failed (exit ${status}) — retrying in ${delay}s: $*" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
  [ "$delay" -gt "$max_delay" ] && delay="$max_delay"
done

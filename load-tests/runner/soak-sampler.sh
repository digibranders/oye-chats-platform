#!/usr/bin/env bash
# Soak sampler: records the SLOPE of resource use across a long run.
#
# A soak is read as a trend, not a number, so this samples once a minute for
# hours and writes a flat CSV. Covers BOTH processes of the split topology,
# because they fail differently: the API workers churn requests while the WS
# process holds long-lived sockets, and a descriptor or buffer leak shows up
# there first.
#
#   ./soak-sampler.sh <out.csv> <duration_s> [interval_s]
set -u
OUT="${1:?out.csv}"; DUR="${2:-86400}"; IVL="${3:-60}"
DB="${DB_HOST:-192.168.252.3}"

echo "ts,api_workers,api_rss_mb,api_fds,ws_workers,ws_rss_mb,ws_fds,pg_total,redis_clients,cpu_idle,mem_avail_mb,api_restarts,ws_restarts" > "$OUT"

# Baseline restart counters: a soak that quietly restarts a worker every hour
# looks healthy in RSS terms while dropping every socket it held.
base_api=$(journalctl -u oye-loadapi --no-pager 2>/dev/null | grep -c "Booting worker" || echo 0)
base_ws=$(journalctl -u oye-loadws --no-pager 2>/dev/null | grep -c "Booting worker" || echo 0)

end=$(( $(date +%s) + DUR ))
while [ "$(date +%s)" -lt "$end" ]; do
  am=$(systemctl show -p MainPID --value oye-loadapi 2>/dev/null)
  wm=$(systemctl show -p MainPID --value oye-loadws 2>/dev/null)
  aw=$(pgrep -P "${am:-0}" 2>/dev/null | wc -l)
  ww=$(pgrep -P "${wm:-0}" 2>/dev/null | wc -l)
  arss=$(ps -o rss= --ppid "${am:-0}" 2>/dev/null | awk '{s+=$1} END{print int(s/1024)}')
  wrss=$(ps -o rss= --ppid "${wm:-0}" 2>/dev/null | awk '{s+=$1} END{print int(s/1024)}')
  afd=0; for p in $(pgrep -P "${am:-0}" 2>/dev/null); do afd=$(( afd + $(ls /proc/$p/fd 2>/dev/null | wc -l) )); done
  wfd=0; for p in $(pgrep -P "${wm:-0}" 2>/dev/null); do wfd=$(( wfd + $(ls /proc/$p/fd 2>/dev/null | wc -l) )); done
  pg=$(psql -w -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname='oyechats_loadtest'" "postgresql://ubuntu@${DB}:5432/oyechats_loadtest" 2>/dev/null)
  rc=$(redis-cli -h "$DB" -n 3 info clients 2>/dev/null | awk -F: '/connected_clients/{print $2+0}')
  idle=$(top -bn1 2>/dev/null | awk -F, '/%Cpu/{for(i=1;i<=NF;i++) if($i ~ /id/){gsub(/[^0-9.]/,"",$i); print $i}}' | head -1)
  mem=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
  ar=$(( $(journalctl -u oye-loadapi --no-pager 2>/dev/null | grep -c "Booting worker" || echo 0) - base_api ))
  wr=$(( $(journalctl -u oye-loadws --no-pager 2>/dev/null | grep -c "Booting worker" || echo 0) - base_ws ))
  echo "$(date +%s),${aw:-},${arss:-},${afd:-},${ww:-},${wrss:-},${wfd:-},${pg:-},${rc:-},${idle:-},${mem:-},${ar},${wr}" >> "$OUT"
  sleep "$IVL"
done

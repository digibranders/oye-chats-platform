#!/usr/bin/env bash
# Soak sampler: records the SLOPE of resource use across a long run.
#
# A soak is read as a trend, not a number, so this samples once a minute for
# hours and writes a flat CSV. Covers BOTH processes of the split topology,
# because they fail differently: the API workers churn requests while the WS
# process holds long-lived sockets, and a descriptor or buffer leak shows up
# there first.
#
# RESTARTS ARE COUNTED FROM PIDs, NOT FROM THE JOURNAL.
# The obvious implementation -- `journalctl -u X | grep -c "Booting worker"` --
# re-reads the whole journal on every sample, and the journal is exactly what a
# soak inflates: the API logs every request, so 9h of load left 919 MB and that
# one line took 45 SECONDS. Run twice per 60s sample, the sampler could no
# longer hold its own interval and silently stretched it -- an 8h46m run wrote
# 350 rows where 526 were due, and the gaps grow as the run goes on. Slopes
# computed from unevenly spaced samples are not trustworthy, so the measurement
# degrades precisely as the run gets long enough to be worth having.
#
# A worker restart is a new child PID under the gunicorn master, which costs one
# pgrep we already run. Constant time, and independent of log volume.
#
#   ./soak-sampler.sh <out.csv> <duration_s> [interval_s]
set -u
OUT="${1:?out.csv}"; DUR="${2:-86400}"; IVL="${3:-60}"
DB="${DB_HOST:-192.168.252.3}"

echo "ts,api_workers,api_rss_mb,api_fds,ws_workers,ws_rss_mb,ws_fds,pg_total,redis_clients,cpu_idle,mem_avail_mb,api_restarts,ws_restarts" > "$OUT"

# Restart counters. A soak that quietly restarts a worker every hour looks
# healthy in RSS terms while dropping every socket it held, so this has to be
# tracked -- just not by reading the journal (see the note above).
#
# `seen_*` holds every worker PID observed so far. A PID in the current child
# set that is not in `seen_*` is a worker that was not there before, i.e. one
# that replaced a dead sibling. The workers alive at startup seed the set and so
# count as zero. If the master itself is restarted every child is new, which
# counts as a full set of restarts -- correct, that is what happened.
seen_api=" "; seen_ws=" "
ar=0; wr=0
for pid in $(pgrep -P "$(systemctl show -p MainPID --value oye-loadapi 2>/dev/null || echo 0)" 2>/dev/null); do
  seen_api="${seen_api}${pid} "
done
for pid in $(pgrep -P "$(systemctl show -p MainPID --value oye-loadws 2>/dev/null || echo 0)" 2>/dev/null); do
  seen_ws="${seen_ws}${pid} "
done

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
  for pid in $(pgrep -P "${am:-0}" 2>/dev/null); do
    case "$seen_api" in *" $pid "*) ;; *) ar=$(( ar + 1 )); seen_api="${seen_api}${pid} ";; esac
  done
  for pid in $(pgrep -P "${wm:-0}" 2>/dev/null); do
    case "$seen_ws" in *" $pid "*) ;; *) wr=$(( wr + 1 )); seen_ws="${seen_ws}${pid} ";; esac
  done
  echo "$(date +%s),${aw:-},${arss:-},${afd:-},${ww:-},${wrss:-},${wfd:-},${pg:-},${rc:-},${idle:-},${mem:-},${ar},${wr}" >> "$OUT"
  sleep "$IVL"
done

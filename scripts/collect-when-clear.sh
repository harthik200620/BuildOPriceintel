#!/usr/bin/env bash
# Waits for the IndiaMART rate limit to clear, then runs the seed collection.
#
# The collector got HTTP 429'd mid-sweep because the first pass was too
# aggressive (1.4 s per request). fetch.ts now starts at a 3.5 s per-host gap
# and doubles it on every 429, but a limit already in force still has to be
# waited out rather than pushed through.
set -u
cd "$(dirname "$0")/.."

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
PROBE="https://dir.indiamart.com/hyderabad/opc-cement.html"
MAX_WAIT_MIN=${MAX_WAIT_MIN:-75}
INTERVAL=180

mkdir -p data/logs
LOG=data/logs/collect-run.out
: > "$LOG"

waited=0
while [ "$waited" -lt $((MAX_WAIT_MIN * 60)) ]; do
  code=$(curl -sL --compressed --max-time 30 -A "$UA" -o /dev/null -w '%{http_code}' "$PROBE" || echo 000)
  echo "[$(date +%H:%M:%S)] probe -> $code (waited ${waited}s)" | tee -a "$LOG"
  if [ "$code" = "200" ]; then
    echo "[$(date +%H:%M:%S)] rate limit cleared; starting collection" | tee -a "$LOG"
    npx tsx collector/run.ts --mode=seed --passes=2 >> "$LOG" 2>&1
    echo "COLLECTOR_EXIT=$?" | tee -a "$LOG"
    exit 0
  fi
  sleep $INTERVAL
  waited=$((waited + INTERVAL))
done

echo "[$(date +%H:%M:%S)] gave up after ${MAX_WAIT_MIN} min still rate-limited" | tee -a "$LOG"
exit 3

#!/usr/bin/env bash
#
# Fill the categories the full sweep could not reach.
#
# The problem this solves is ordering, not politeness. `npm run collect` walks
# categories in a fixed order, and cement — 13 seed slugs, each with a crawl
# frontier and pagination — spends the whole per-host budget before TMT, pipes
# and bricks are reached. Whatever is last in the order gets a 429 and nothing
# else. Running one category at a time gives each the full budget.
#
# Probe once every PROBE_GAP seconds with a single request. That is far gentler
# than the collector itself and stops the moment it succeeds. Bounded by
# MAX_WAIT so this cannot sit against someone's server indefinitely.
#
#   bash scripts/collect-missing-when-clear.sh
#
set -u

cd "$(dirname "$0")/.."

CATEGORIES=${CATEGORIES:-"water_pipes tmt_steel bricks_blocks"}
PROBE_URL=${PROBE_URL:-"https://dir.indiamart.com/hyderabad/cpvc-pipe.html"}
PROBE_GAP=${PROBE_GAP:-720}      # 12 min between probes
REST_GAP=${REST_GAP:-600}        # 10 min rest between category sweeps
MAX_WAIT=${MAX_WAIT:-14400}      # give up after 4 h
UA="BuildObjectsPriceIntel/0.1 (local research demo; contact harthikvarma0@gmail.com)"
LOG="data/logs/collect-missing.out"

mkdir -p data/logs
say() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

probe() {
  curl -sL -o /dev/null -w "%{http_code}" --compressed -A "$UA" \
    -H "Accept-Language: en-IN,en;q=0.9" --max-time 30 "$PROBE_URL" 2>/dev/null
}

say "waiting for IndiaMART to clear — probing every ${PROBE_GAP}s, giving up after ${MAX_WAIT}s"

waited=0
while :; do
  code=$(probe)
  say "probe -> HTTP ${code:-000}"
  if [ "$code" = "200" ]; then break; fi
  if [ "$waited" -ge "$MAX_WAIT" ]; then
    say "gave up after ${waited}s still throttled. Nothing collected; existing data untouched."
    say "The 06:30 scheduled task will retry on its own."
    exit 2
  fi
  sleep "$PROBE_GAP"
  waited=$((waited + PROBE_GAP))
done

say "clear. sweeping one category at a time."

for cat in $CATEGORIES; do
  say "── $cat ─────────────────────────────"
  npm run collect -- --mode=manual --category="$cat" --passes=2 2>&1 | tee -a "$LOG" | tail -25
  say "$cat done; resting ${REST_GAP}s before the next category"
  sleep "$REST_GAP"
done

say "all categories attempted. reconciling filter trees against the new data."
npm run reconcile 2>&1 | tee -a "$LOG" | tail -8
say "done."

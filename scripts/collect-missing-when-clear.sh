#!/usr/bin/env bash
#
# Sweep the categories one at a time, each behind its own gate.
#
# The problem this solves is ordering, not politeness. `npm run collect` walks
# categories in a fixed order, and cement — 13 seed slugs, each with a crawl
# frontier and pagination — spends the whole per-host budget before TMT, pipes
# and bricks are reached. Whatever is last in the order gets a 429 and nothing
# else. Running one category at a time gives each the full budget.
#
# The gate is per category, not once up front. A fixed rest between sweeps was
# tried first (REST_GAP=600) and measured too short: IndiaMART's throttle
# window after a heavy sweep is 1h00m–1h48m, so the second category began
# inside it and captured nothing. Now each category waits — probing every
# PROBE_GAP seconds with a single request, far gentler than the collector, and
# stopping the moment it succeeds — until the host answers 200. Bounded by
# MAX_WAIT per category so this cannot sit against someone's server forever.
#
#   bash scripts/collect-missing-when-clear.sh
#   CATEGORIES="cement" bash scripts/collect-missing-when-clear.sh
#
set -u

cd "$(dirname "$0")/.."

CATEGORIES=${CATEGORIES:-"cement tmt_steel water_pipes bricks_blocks"}
PROBE_URL=${PROBE_URL:-"https://dir.indiamart.com/hyderabad/cpvc-pipe.html"}
PROBE_GAP=${PROBE_GAP:-720}      # 12 min between probes
REST_GAP=${REST_GAP:-120}        # short pause before the next category's gate
MAX_WAIT=${MAX_WAIT:-14400}      # give up on one category after 4 h
PASSES=${PASSES:-2}
UA="BuildObjectsPriceIntel/0.1 (local research demo; contact harthikvarma0@gmail.com)"
LOG="data/logs/collect-missing.out"

mkdir -p data/logs
say() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

probe() {
  curl -sL -o /dev/null -w "%{http_code}" --compressed -A "$UA" \
    -H "Accept-Language: en-IN,en;q=0.9" --max-time 30 "$PROBE_URL" 2>/dev/null
}

# Wait until the host answers 200. Returns 0 when clear, 2 when MAX_WAIT passed.
wait_clear() {
  local waited=0 code
  while :; do
    code=$(probe)
    say "probe -> HTTP ${code:-000}"
    [ "$code" = "200" ] && return 0
    if [ "$waited" -ge "$MAX_WAIT" ]; then
      say "still throttled after ${waited}s — giving up on this category; existing data untouched."
      return 2
    fi
    sleep "$PROBE_GAP"
    waited=$((waited + PROBE_GAP))
  done
}

skipped=""
for cat in $CATEGORIES; do
  say "── $cat ───────────────────────────── waiting for IndiaMART to clear (probe every ${PROBE_GAP}s, up to ${MAX_WAIT}s)"
  if ! wait_clear; then skipped="$skipped $cat"; continue; fi
  say "clear. sweeping $cat (passes=$PASSES)"
  npm run collect -- --mode=manual --category="$cat" --passes="$PASSES" 2>&1 | tee -a "$LOG" | tail -30
  say "$cat done; resting ${REST_GAP}s before the next category's gate"
  sleep "$REST_GAP"
done

say "all categories attempted.${skipped:+ skipped (still throttled):$skipped} reconciling filter trees against the new data."
npm run reconcile 2>&1 | tee -a "$LOG" | tail -8
say "done."

#!/usr/bin/env bash
#
# Read the remaining listing detail pages for their galleries, once it is
# polite to do so.
#
# Two things have to be true before this starts, and they are different things:
#
#   1. No category sweep is running. `npm run collect` and this script draw on
#      the same per-host budget, and racing them just means both get throttled.
#   2. IndiaMART is actually answering. A run that starts against a live 429
#      trips the circuit breaker on its first request and achieves nothing.
#
# The image collector is resumable — `image_page_log` records which pages have
# been read — so this is additive whenever it manages to run, and safe to run
# again after it stops early.
#
#   bash scripts/images-when-clear.sh
#
set -u
cd "$(dirname "$0")/.."

PROBE_URL=${PROBE_URL:-"https://www.indiamart.com/proddetail/acc-suraksha-power-cement-2858939420333.html"}
PROBE_GAP=${PROBE_GAP:-600}      # 10 min between probes
MAX_WAIT=${MAX_WAIT:-14400}      # give up after 4 h
PAGES=${PAGES:-400}
UA="BuildOPriceIntel/0.1 (local research demo; contact harthikvarma0@gmail.com)"
LOG="data/logs/images-when-clear.out"

mkdir -p data/logs
say() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

sweep_running() {
  powershell -NoProfile -Command \
    "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*collector/run*' } | Measure-Object).Count" \
    2>/dev/null | tr -d '\r' | grep -qv '^0$'
}

say "waiting for a clear window — probing every ${PROBE_GAP}s, giving up after ${MAX_WAIT}s"

waited=0
while :; do
  if sweep_running; then
    say "a category sweep is running; standing down"
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" --compressed -A "$UA" --max-time 30 "$PROBE_URL" 2>/dev/null)
    say "probe -> HTTP ${code:-000}"
    if [ "$code" = "200" ]; then break; fi
  fi
  if [ "$waited" -ge "$MAX_WAIT" ]; then
    say "gave up after ${waited}s. Nothing fetched; the pool already on disk is untouched."
    exit 2
  fi
  sleep "$PROBE_GAP"
  waited=$((waited + PROBE_GAP))
done

say "clear. reading up to ${PAGES} unread detail pages."
npx tsx scripts/collect-images.ts --apply --pages="$PAGES" 2>&1 | tee -a "$LOG" | tail -30
say "done."

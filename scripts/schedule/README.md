# The 24-hour refresh

A local scheduled job. No cloud scheduler, no hosted anything.

## Windows — register it

From the repo root, one line:

```bash
schtasks /Create /TN "Build Objects PriceIntel Daily Refresh" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%CD%\scripts\schedule\buildobjects-refresh.ps1\"" /SC DAILY /ST 06:30 /F
```

Check it, run it on demand, or remove it:

```bash
schtasks /Query /TN "Build Objects PriceIntel Daily Refresh" /V /FO LIST
```

```bash
schtasks /Run /TN "Build Objects PriceIntel Daily Refresh"
```

```bash
schtasks /Delete /TN "Build Objects PriceIntel Daily Refresh" /F
```

## macOS / Linux — the cron equivalent

```bash
30 6 * * * cd /path/to/BuildObjects-PriceIntel && /usr/bin/env npm run collect >> data/logs/cron.out 2>&1
```

## What a run does

1. **Collects** across every registered adapter, two passes, stopping when a pass surfaces nothing new.
2. **Loads transactionally.** `price_current` is deleted and rebuilt inside one transaction, so a reader never sees a half-written price surface.
3. **Appends** every observation to `price_history` — this is what the PDP chart is built from.
4. **Reconciles** the filter trees so facet counts stay measured rather than drifting into fiction.
5. **Writes** `data/snapshots/<date>/<category>.{json,csv}` and `data/logs/diff-<date>.md`.

## What a *failed* run does

Nothing destructive. The collector writes into the DB only after a source answers; `price_current` is replaced in a single transaction or not at all. If the run fails:

- previous prices stay exactly where they were,
- their age keeps increasing, so they move FRESH → AGEING → STALE on schedule,
- `/api/meta` reports `degraded: true` and the app shows the degraded banner,
- the script exits non-zero so Task Scheduler's *Last Run Result* shows the failure rather than a green tick.

## The honest limitation

The unattended job can only refresh sources that answer a scripted client. On this machine that is IndiaMART (when not rate-limiting), the Telangana PRED government index, and the trade directories.

**It cannot refresh the browser-assisted captures.** Amazon, Flipkart, BigBMart, BuildersMART, Moglix and Justdial all serve a browser challenge, a JS wall or a bot check to a script. Their rows are loaded from `collector/raw/assisted-*.jsonl`, and the collector logs them with the date they were captured — so a stale assisted capture appears in the diff log as needing a fresh pass rather than quietly ageing into the background. Refreshing those needs an operator with a browser.

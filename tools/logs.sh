#!/usr/bin/env bash
# Read the central diagnostics log (what the phones reported in the last hours).
#   tools/logs.sh            last 12 hours, all devices
#   tools/logs.sh 2h         last 2 hours
#   tools/logs.sh 12h ab3k9  only device "ab3k9" (the id shown under "משהו לא עובד?")
SINCE="${1:-12h}"
DEV="${2:-}"
TOPIC="${DV_LOG_TOPIC:-dv5g-logs-k7q2m9x4t1}"
curl -sS -m 30 "https://ntfy.sh/${TOPIC}/json?poll=1&since=${SINCE}" | python3 -c '
import sys, json, time
dev = sys.argv[1]
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: m = json.loads(line)
    except Exception: continue
    if m.get("event") != "message": continue
    body = m.get("message", "")
    head = body.split("\n", 1)[0]
    if dev and ("#" + dev) not in head: continue
    print("=" * 70)
    print(time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(m["time"])), head)
    print(body.split("\n", 1)[1] if "\n" in body else "")
' "$DEV"

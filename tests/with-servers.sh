#!/usr/bin/env bash
# Start the static server (8765) and the local relay brokers (9101, 9102), run a command, stop them.
#   tests/with-servers.sh node tests/visual.js
cd "$(dirname "$0")/.."
python3 -m http.server 8765 >/dev/null 2>&1 & S1=$!
node tests/local-broker.js 9101 9102 >/dev/null 2>&1 & S2=$!
sleep 1.5
"$@"; CODE=$?
kill $S1 $S2 2>/dev/null
exit $CODE

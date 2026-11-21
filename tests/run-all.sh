#!/usr/bin/env bash
# The full regression suite. Run before every release:   tests/run-all.sh
# (optionally against the live site for the parts that do not need the local relay: tests/run-all.sh live)
cd "$(dirname "$0")/.."
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"
FAIL=0
step() {
  local name="$1"; shift
  local out; out=$("$@" 2>&1); local code=$?
  if [ $code -eq 0 ]; then echo "✔ $name — $(echo "$out" | grep -v '^\s*$' | tail -1)"; else echo "✘ $name"; echo "$out" | tail -25; FAIL=1; fi
}
step "game & series rules"            node tests/logic.test.mjs
step "turn look / sound / help"       tests/with-servers.sh node tests/turn-ui.js
step "analytics events & privacy"     tests/with-servers.sh node tests/analytics.js
step "taps land where they should"    tests/with-servers.sh node tests/interact.js
step "two full series through the UI" tests/with-servers.sh node tests/e2e-games.js http://localhost:8765/ 2
step "disconnects (relay only)"       env MODE=relay tests/with-servers.sh node tests/e2e-net.js
step "disconnects (relay + direct)"   env MODE=both tests/with-servers.sh node tests/e2e-net.js
step "relay servers fail and return"  tests/with-servers.sh node tests/e2e-outage.js
step "every screen on 14 sizes"       tests/with-servers.sh node tests/visual.js http://localhost:8765/ visual-out
if command -v xvfb-run >/dev/null && /usr/bin/python3.12 -c "import gi" 2>/dev/null; then
  step "WebKit (iPhone engine)"       tests/with-servers.sh tests/webkit-all.sh visual-out/webkit
fi
if [ "$1" = "live" ]; then
  step "LIVE: turn look / sound / help" node tests/turn-ui.js https://small-joys.com/
  step "LIVE: taps"                     node tests/interact.js https://small-joys.com/
  step "LIVE: disconnects"              env MODE=live node tests/e2e-net.js https://small-joys.com/
fi
[ $FAIL -eq 0 ] && echo "ALL GREEN" || echo "SOMETHING FAILED"
exit $FAIL

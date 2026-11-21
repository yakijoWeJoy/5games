#!/usr/bin/env python3
"""
New-player funnel from PostHog: from the first visit to the first finished game, and where people get stuck.

    POSTHOG_PERSONAL_KEY=phx_... python3 tools/funnel.py            # last 7 days
    POSTHOG_PERSONAL_KEY=phx_... python3 tools/funnel.py 30         # last 30 days
    POSTHOG_PERSONAL_KEY=phx_... python3 tools/funnel.py 7 tiktok   # only players a source brought (utm_source / src)

The personal key (PostHog -> Settings -> Personal API keys) needs the scope "query:read".
A "player" is one anonymous device that was new in the period.
"""
import json, os, sys, urllib.request, urllib.error

HOST = os.environ.get('POSTHOG_HOST', 'https://eu.posthog.com')
KEY = os.environ.get('POSTHOG_PERSONAL_KEY', '')
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
SRC = sys.argv[2].lower() if len(sys.argv) > 2 else ''


def api(path, body=None):
    req = urllib.request.Request(HOST + path, data=json.dumps(body).encode() if body else None,
                                 headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f'PostHog said {e.code}: {e.read().decode()[:400]}')


def q(sql):
    return api(f'/api/projects/{PID}/query/', {'query': {'kind': 'HogQLQuery', 'query': sql}})['results']


if not KEY:
    sys.exit('set POSTHOG_PERSONAL_KEY (PostHog -> Settings -> Personal API keys, scope query:read)')
PID = os.environ.get('POSTHOG_PROJECT_ID') or api('/api/projects/@current/')['id']

# one row per new device: what it reached, and where it was when it stopped
PLAYERS = f"""
SELECT distinct_id,
  argMin(properties.entry, timestamp) AS entry,
  argMin(coalesce(properties.campaign_source, properties.invited_from_source, properties.utm_source, ''), timestamp) AS src,
  argMin(properties.$os, timestamp) AS os,
  argMin(properties.$browser, timestamp) AS browser,
  argMin(coalesce(toString(properties.ui_lang), '?'), timestamp) AS ui_lang,
  countIf(event = 'room_created') > 0 AS hosted,
  countIf(event = 'join_submitted') > 0 AS joined,
  countIf(event = 'partner_joined' OR (event = 'connected' AND properties.role = 'guest')) > 0 AS paired,
  countIf(event = 'game_started') > 0 AS started,
  countIf(event = 'game_completed') > 0 AS completed,
  countIf(event = 'name_missing') AS name_missing,
  countIf(event = 'join_code_invalid') AS bad_code,
  countIf(event = 'trouble_opened') AS trouble,
  arrayStringConcat(groupUniqArrayIf(toString(properties.status), event = 'connection_problem'), ',') AS problems,
  argMaxIf(toString(properties.screen_type), timestamp, event = 'screen_viewed') AS last_screen,
  maxIf(toFloat(properties.duration_s), event = '$pageleave') AS longest_visit_s,
  argMaxIf(toString(properties.game), timestamp, event = 'game_abandoned') AS abandoned_game,
  argMaxIf(toString(properties.phase), timestamp, event = 'game_abandoned') AS abandoned_phase
FROM events
WHERE timestamp > now() - INTERVAL {DAYS} DAY
GROUP BY distinct_id
HAVING countIf(event = '$pageview' AND toString(properties.is_new_user) = 'true'
               AND coalesce(toString(properties.utm_source), '') != 'setup_check') > 0
"""
where = f"WHERE lower(src) = '{SRC}'" if SRC.replace('_', '').replace('-', '').isalnum() else ''
rows = q(f"SELECT * FROM ({PLAYERS}) {where}")
cols = ['id', 'entry', 'src', 'os', 'browser', 'ui_lang', 'hosted', 'joined', 'paired', 'started', 'completed', 'name_missing', 'bad_code',
        'trouble', 'problems', 'last_screen', 'visit_s', 'ab_game', 'ab_phase']
P = [dict(zip(cols, r)) for r in rows]
pct = lambda a, b: f'{100 * a / b:5.1f}%' if b else '   - '


def table(title, items):
    print(f'\n{title}')
    for k, v in items: print(f'   {v:>5}  {k}')


def count(players, key):
    out = {}
    for p in players:
        k = p[key] if p[key] not in (None, '') else '(none)'
        out[k] = out.get(k, 0) + 1
    return sorted(out.items(), key=lambda x: -x[1])


print(f'New players in the last {DAYS} days{" from " + SRC if SRC else ""}: {len(P)}')
if not P: sys.exit()

is_guest = lambda p: p['entry'] == 'invite_link' or (p['joined'] and not p['hosted'])
for path, who in (('HOST path (opened the site, makes a room)', lambda p: not is_guest(p)),
                  ('GUEST path (invite link or typed a code)', is_guest)):
    G = [p for p in P if who(p)]
    if not G: continue
    first = 'hosted' if 'HOST' in path else 'joined'
    steps = [('visited', len(G)),
             ('created a room' if first == 'hosted' else 'pressed join', sum(1 for p in G if p[first] or p['paired'])),
             ('playing together (partner connected)', sum(1 for p in G if p['paired'])),
             ('started a game', sum(1 for p in G if p['started'])),
             ('finished a game', sum(1 for p in G if p['completed']))]
    print(f'\n=== {path}: {len(G)} players')
    prev = None
    for name, n in steps:
        print(f'   {name:<38} {n:>5}  {pct(n, len(G))} of all' + (f'   {pct(n, prev)} of previous step' if prev is not None else ''))
        prev = n
    # who stopped where, and what they saw last
    stuck = [
        ('left before ' + ('creating a room' if first == 'hosted' else 'pressing join'), [p for p in G if not (p[first] or p['paired'])]),
        ('never got a partner connected', [p for p in G if (p[first] or p['paired']) and not p['paired']]),
        ('connected but no game started', [p for p in G if p['paired'] and not p['started']]),
        ('started but never finished a game', [p for p in G if p['started'] and not p['completed']]),
    ]
    for label, S in stuck:
        if not S: continue
        print(f'\n -- {len(S)} {label}')
        table('    last screen they saw:', count(S, 'last_screen'))
        probs = [p for p in S if p['problems']]
        if probs: table('    connection problems seen:', count(probs, 'problems'))
        n_name = sum(1 for p in S if p['name_missing']); n_code = sum(1 for p in S if p['bad_code']); n_tr = sum(1 for p in S if p['trouble'])
        if n_name or n_code or n_tr: print(f'    pressed without a name: {n_name} · typed a wrong code: {n_code} · opened "something is wrong": {n_tr}')
        ab = [p for p in S if p['ab_game']]
        if ab: table('    quit inside game (game / phase):', count([{**p, 'k': f"{p['ab_game']} / {p['ab_phase']}"} for p in ab], 'k'))

print('\n=== finished a first game, by browser (spot a browser where people get stuck)')
for b, n in count(P, 'browser'):
    done = sum(1 for p in P if (p['browser'] or '(none)') == b and p['completed'])
    print(f'   {b:<30} {n:>5} players  {pct(done, n)} finished a game')
print('\n=== by language (Hebrew vs English screens)')
for lg, n in count(P, 'ui_lang'):
    done = sum(1 for p in P if (p['ui_lang'] or '(none)') == lg and p['completed'])
    print(f'   {lg:<30} {n:>5} players  {pct(done, n)} finished a game')
if not SRC:
    print('\n=== by source')
    for s, n in count(P, 'src'):
        done = sum(1 for p in P if (p['src'] or '(none)') == s and p['completed'])
        print(f'   {s:<30} {n:>5} players  {pct(done, n)} finished a game')

# connection speed and failures (everyone, not only new players)
c = q(f"""SELECT count(), quantile(0.5)(toFloat(properties.ms)), quantile(0.9)(toFloat(properties.ms))
FROM events WHERE event = 'connected' AND timestamp > now() - INTERVAL {DAYS} DAY""")[0]
print(f'\n=== connecting: {c[0]} connections, median {(c[1] or 0) / 1000:.1f}s, slowest 10% over {(c[2] or 0) / 1000:.1f}s')
for st, n in q(f"""SELECT toString(properties.status), count() FROM events WHERE event = 'connection_problem'
  AND timestamp > now() - INTERVAL {DAYS} DAY GROUP BY 1 ORDER BY 2 DESC"""):
    print(f'   problem "{st}": {n}')
errs = q(f"""SELECT toString(properties.message), toString(properties.app_version), count() FROM events WHERE event = 'js_error'
  AND timestamp > now() - INTERVAL {DAYS} DAY GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 5""")
if errs:
    print('\n=== top script errors')
    for m, v, n in errs: print(f'   {n:>4}  v{v}  {m}')

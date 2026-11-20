# Product analytics

Two separate systems:

| | **Product analytics** (`js/analytics.js`) | **Technical log** (`js/log.js`) |
|---|---|---|
| Question it answers | How do people use the games? What should we improve? | Why did this phone fail to connect? |
| Where it goes | PostHog (EU cloud) | ntfy.sh topic, read with `tools/logs.sh` |
| How long it is kept | 7 years on the free plan (1M events/month free) | ~12 hours |

## Switching it on (one time, ~5 minutes)

1. Sign up at <https://eu.posthog.com/signup> (EU hosting keeps the data in Europe).
2. Create a project and name it after the game (`דף ועיפרון`).
3. **Project settings → Project API key**: copy the key that starts with `phc_`. This key can only *send* events, so it's safe to publish.
4. Paste it into `js/analytics.js`, in `const POSTHOG_KEY = '';`, and release a new version. If you send the key to Claude, it can do this step.
5. Recommended project settings:
   - **Autocapture, session replay, heatmaps: off.** We send our own events, and replays could record names.
   - **Discard client IP data: on.** PostHog still works out the country first.
   - Time zone: Asia/Jerusalem.

Nothing is sent when:
- `POSTHOG_KEY` is empty
- the site runs on localhost or with `?local` / `?demo`
- the browser sends Global Privacy Control

## What is never sent

Player names, note text, secret codes, hangman words, board moves, room codes. The anonymous ID is a random UUID kept in `localStorage`. No cookies are used.

## Event dictionary

The following properties are on **every event**:
- `role`: `host` or `guest`
- `app_version`
- `days_since_first_seen`
- `$session_id`: a new session starts after 30 minutes idle
- `$os`, `$browser`, `$device_type`
- `standalone`: added to the home screen
- `lang`, `net_type`
- screen size

> **Game events are reported by both phones.** To count games or series, filter `role = host` (or count unique `game_uid`). Use both phones for per-player questions, for example "do players who lose come back?", which uses `my_outcome`.

### Acquisition and activation (the funnel)
| Event | When | Key properties |
|---|---|---|
| `$pageview` | every page load | `entry` (`direct` / `invite_link` / `resume`), `$referring_domain`, `utm_*`, `is_new_user` |
| `screen_viewed` | screen changes | `screen_type` (home, join, invite, menu, game, result, connecting), `game`, `phase` |
| `room_created` | host presses "open a new sheet" | `is_first_room` |
| `invite_shared` | host shares the invite | `method` (`native_share` / `copy_link` / `manual_copy` / `whatsapp`), `from` |
| `invite_share_cancelled` | the share sheet was closed | `from` |
| `join_submitted` | guest presses join | `via` (`invite_link` / `typed_code`), `is_first_join` |
| `join_code_invalid` | typed code wasn't 4 digits | `length` |
| `partner_joined` | host: the second phone arrived | `seconds_waiting`, `is_replacement` |
| `connected` | first successful link in this page load | `ms` (time to connect), `direct` (WebRTC vs relay), `resumed` |

### Core loop
| Event | Key properties |
|---|---|
| `game_started` | `game`, `game_index` (1–5), `series_n`, `is_rematch`, `opener`, `game_uid` |
| `game_completed` | + `outcome` (`host_won` / `guest_won` / `tie`), `my_outcome`, `duration_s`, `moves`, `series_score` |
| `game_abandoned` | + `phase`, `duration_s`, `moves`, `reason` (`to_menu` / `new_series` / `evening_reset`), `left_by` |
| `series_started` | `series_n`, `previous_finished`, `previous_decided` |
| `series_decided` | someone reached 3 wins: `games_played`, `winner`, `score` |
| `series_completed` | all 5 games played: `winner`, `score`, `played_on_after_decided` |
| `series_abandoned` | new series / reset in the middle: `games_played`, `score`, `reason` |
| `evening_reset` | `series_played` |
| `rematch_prompt` / `leave_game_prompt` | `game`, `confirmed` (did they go through with it?) |

### Features
| Event | Key properties |
|---|---|
| `tutorial_viewed` | `game`, `trigger` (`auto` = first time, `asked` = pressed "?"), `in_game_phase` |
| `tutorial_closed` | `game`, `trigger`, `seconds_open` |
| `note_sent` | `kind` (`quick` + which ready-made note, or `typed` + `length` bucket) |
| `sound_toggled` | `on` |
| `partner_replaced` | `series_n` |
| `room_left` | `in_game`, `series_n`, `games_in_series`, `partner_joined`, `minutes_in_room` |
| `$pageleave` | `duration_s`, `last_screen` |

### Quality
| Event | Key properties |
|---|---|
| `connection_problem` | `status` (`offline` / `no-host` / `full` / `waiting`), `was_linked`, `in_game` |
| `connection_recovered` | `problem`, `seconds_down`, `in_game` |
| `trouble_opened` | someone opened "something isn't working?": `status`, `screen` |
| `problem_reported` | `log_device`: joins the analytics event to the ntfy technical log of that device |
| `js_error` | `message`, `file`, `line`, `screen` (at most 5 per page load) |
| `version_mismatch` | the two phones run different releases |

### Person properties (for cohorts)
These are set only once:
- `first_seen_at`, `first_version`, `first_entry`, `first_role`
- `$initial_referring_domain`, `$initial_utm_*`

These are updated over time:
- `last_version`
- `lifetime_sessions`, `lifetime_rooms_hosted`, `lifetime_rooms_joined`, `lifetime_games_completed`, `lifetime_series_completed`

## Dashboards to build in PostHog

1. **Activation funnel** (Funnel, by unique users, 30 min window):
   - Host steps: `$pageview` → `room_created` → `invite_shared` → `partner_joined` → `game_completed` (`role = host`) → `series_decided`.
   - Guest steps: `$pageview` (`entry = invite_link`) → `join_submitted` → `connected` → `game_completed` (`role = guest`).

   The biggest drop shows what to fix first.
2. **Virality**:
   - Divide `partner_joined` by `room_created`.
   - Track how many users with `first_role = guest` later fire `room_created`. These are guests who became hosts, the growth loop.
   - Break down `invite_shared` by `method`.
3. **Retention** (Retention insight): first event `game_completed`, returning event `game_completed`, weekly. Break it down by `first_role` and by the `my_outcome` of the first game.
4. **Per-game health**: break down `game_started`, `game_completed` and `game_abandoned` by `game` (`role = host`). Track:
   - completion rate per game
   - median `duration_s`
   - `phase` at abandon
   - rematch rate (`is_rematch`)

   A game with a high abandon rate, or one that's abandoned in its setup phase, is the one to redesign.
5. **Series depth**: break down `game_started` by `game_index`, to see how far into the series people get. Compare `series_decided` with `series_completed` and look at `played_on_after_decided`.
6. **Balance**: break down `game_completed` (`role = host`) by `outcome` and `opener`. If the opener wins far more than half the time, the game is unfair.
7. **Tutorials**: `tutorial_closed.seconds_open` by game, and `tutorial_viewed` with `trigger = asked` by game. Players re-opening the rules means the rules aren't clear.
8. **Connection quality**:
   - `connected.ms` (p50 / p90)
   - `connection_problem` by `status`, `$os` and `$browser`
   - `connection_recovered.seconds_down`
   - `js_error` trend by `app_version`

   Check these after every release.

## Release checklist

- Bump the version (`?v=` in `index.html` and `VERSION` in `js/log.js`). Every event carries `app_version`, so you can compare releases.
- `tests/run-all.sh` includes `tests/analytics.js`. That test catches every request to the analytics server and checks:
  - which events are sent
  - that names, secret codes and room codes are never sent
  - that events made offline are sent later
  - that local runs send nothing

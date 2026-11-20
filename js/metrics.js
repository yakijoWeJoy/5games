/*
 * Product-analytics events derived from the shared game state (pure, no DOM, no network).
 * Given the state a phone saw before and the state it sees now, returns what happened in between:
 * games started / completed / abandoned, series decided / completed / abandoned, evening reset.
 *
 * Both phones run this, so every event exists twice (once per phone, with role host|guest).
 * To COUNT games or series use role = host (or unique game_uid); per-player questions
 * ("do players who lose come back?") use both, with my_outcome.
 */
import { GAMES, seriesWins, seriesDecided, seriesDone } from './core.js';

const ROLE = ['host', 'guest'];
const secs = (a, b) => (a && b && b >= a ? Math.round((b - a) / 1000) : null);
const outcome = w => (w == null ? 'tie' : w === 0 ? 'host_won' : 'guest_won');
const mine = (w, me) => (w == null ? 'tie' : w === me ? 'won' : 'lost');
const score = s => { const w = seriesWins(s); return `${w[0]}-${w[1]}${w[2] ? '-' + w[2] : ''}`; };

function gameProps(s, g, game) {
  const m = g.meta || {};
  return {
    game,
    game_uid: g.id,
    game_index: g.sidx >= 0 ? g.sidx + 1 : null,   // 1..5 position in the series
    series_n: s.series.n,
    is_rematch: !!m.rp,
    moves: m.n || 0,
    opener: g.sidx >= 0 ? ROLE[(s.series.n + g.sidx) % 2] : null,
  };
}

/**
 * @param prev state before (or null)   @param next state now   @param me 0 = host phone, 1 = guest phone
 * @param now  clock of this phone (ms) – only used for abandoned games
 * @returns [{ event, props }]
 */
export function gameEvents(prev, next, me, now = Date.now()) {
  const out = [];
  if (!prev || !next || prev.sid !== next.sid || prev === next) return out;
  const add = (event, props) => out.push({ event, props: { room_id: next.sid, ...props } });
  const pg = prev.game, ng = next.game;
  const resetEvening = next.series.n < prev.series.n || (next.series.n === 1 && prev.series.n === 1 && prev.series.results.length > next.series.results.length && !ng);
  const newSeries = next.series.n > prev.series.n;

  // a running game was left without a result
  if (pg && !pg.over && (!ng || ng.id !== pg.id)) {
    const reason = newSeries ? 'new_series' : resetEvening ? 'evening_reset' : !ng ? 'to_menu' : 'replaced';
    add('game_abandoned', {
      ...gameProps(prev, pg, prev.current), phase: pg.phase || null,
      duration_s: secs(pg.meta && pg.meta.t0, now), reason,
      left_by: reason === 'to_menu' && next.leftBy != null ? ROLE[next.leftBy] : null,
    });
  }

  // series closed by "new series" / "reset evening"
  if (newSeries || resetEvening) {
    const played = prev.series.results.length;
    if (played && seriesDecided(prev) == null && !seriesDone(prev)) {
      add('series_abandoned', { series_n: prev.series.n, games_played: played, score: score(prev), reason: resetEvening ? 'evening_reset' : 'new_series' });
    }
    if (resetEvening) add('evening_reset', { series_played: prev.series.n - (played ? 0 : 1) });
    else add('series_started', { series_n: next.series.n, previous_finished: seriesDone(prev), previous_decided: seriesDecided(prev) != null });
  }

  if (ng && (!pg || ng.id !== pg.id)) add('game_started', gameProps(next, ng, next.current));

  if (ng && ng.over && (!pg || pg.id !== ng.id || !pg.over)) {
    const m = ng.meta || {};
    const w = ng.over.winner;
    add('game_completed', {
      ...gameProps(next, ng, next.current),
      outcome: outcome(w), my_outcome: mine(w, me),
      duration_s: secs(m.t0, m.t1),
      series_score: ng.sidx >= 0 ? score(next) : null,
    });
  }

  // series milestones (only when the series itself did not change)
  if (!newSeries && !resetEvening && next.series.results.length > prev.series.results.length) {
    const before = seriesDecided(prev), after = seriesDecided(next);
    const played = next.series.results.length;
    if (before == null && after != null) {
      add('series_decided', { series_n: next.series.n, games_played: played, winner: ROLE[after], my_outcome: mine(after, me), score: score(next) });
    }
    if (!seriesDone(prev) && seriesDone(next)) {
      const w = seriesWins(next);
      const leader = w[0] > w[1] ? 0 : w[1] > w[0] ? 1 : null;
      add('series_completed', {
        series_n: next.series.n, games_played: GAMES.length, winner: leader == null ? 'tie' : ROLE[leader],
        my_outcome: mine(leader, me), score: score(next), played_on_after_decided: before != null,
      });
    }
  }
  return out;
}

/* Pure shared-state logic (no DOM) – the host phone runs this, tests import it too. */
import { rid } from './ui.js';
import bull from './games/bull.js';
import hangman from './games/hangman.js';
import ships from './games/ships.js';
import dots from './games/dots.js';
import five from './games/five.js';

export const GAMES = [bull, hangman, ships, dots, five];
export const BY = Object.fromEntries(GAMES.map(G => [G.id, G]));
export const STATE_V = 2;
export const NEED = 3; // wins that decide a best-of-five series

export const cleanName = n => String(n || '').trim().slice(0, 14) || 'שחקן';

export function newState(name, token) {
  return {
    v: STATE_V, rev: 0, sid: rid(10),
    players: [{ name, token }, { name: null, token: null }],
    // a series = the five games in order, best of five
    series: { n: 1, results: [] },   // results[i] = { game, winner: 0 | 1 | null(tie) }
    evening: [0, 0, 0],              // series won by player 0, by player 1, tied
    current: null, game: null, leftBy: null,
    chat: [],
    acks: [], // ids of guest actions already handled (so a re-sent action is never applied twice)
  };
}

const gameId = s => (s.game ? s.game.id : null);

/** [wins of player 0, wins of player 1, ties] in the current series */
export function seriesWins(s) {
  const w = [0, 0, 0];
  for (const r of s.series.results) w[r.winner == null ? 2 : r.winner]++;
  return w;
}
export const seriesDone = s => s.series.results.length >= GAMES.length;
/** the player who already secured the series (3 wins), or null */
export function seriesDecided(s) {
  const w = seriesWins(s);
  return w[0] >= NEED ? 0 : w[1] >= NEED ? 1 : null;
}
/** who is ahead right now: 0 | 1 | null (level) */
export function seriesLeader(s) {
  const w = seriesWins(s);
  return w[0] > w[1] ? 0 : w[1] > w[0] ? 1 : null;
}
/** the game that has to be played now, or null when all five are done */
export const nextGame = s => (seriesDone(s) ? null : GAMES[s.series.results.length].id);

function startGame(s, idx, counts) {
  const G = GAMES[idx];
  // who opens alternates from game to game and from series to series; a replay keeps the same opener
  const st = (s.series.n + idx) % 2;
  s.current = G.id;
  s.game = G.init(st);
  s.game.id = rid();
  s.game.sidx = counts ? idx : -1;
  s.game.counted = false;
}

function closeSeries(s) {
  // a finished or already decided series goes into the evening tally; an abandoned one does not
  const dec = seriesDecided(s);
  if (dec != null) s.evening[dec]++;
  else if (seriesDone(s)) { const l = seriesLeader(s); s.evening[l == null ? 2 : l]++; }
}

/**
 * Apply action `a` of player `p` to state `s` (mutates). Returns false if the action is not allowed.
 * opts.test enables the `jump` action used by the automated network tests.
 */
export function reduce(s, p, a, opts) {
  if (!a || typeof a !== 'object' || (p !== 0 && p !== 1)) return false;
  // `from` = the game the player was looking at; protects against two phones pressing at once
  const fromOk = () => !('from' in a) || a.from === gameId(s);
  const idle = !s.game || !!s.game.over;
  switch (a.k) {
    case 'chat': {
      const text = String(a.text || '').trim().slice(0, 240);
      if (!text) return false;
      s.chat.push({ id: rid(), p, text, t: Date.now() });
      if (s.chat.length > 80) s.chat.splice(0, s.chat.length - 80);
      return true;
    }
    case 'next': {
      // the series is played in order – no skipping
      if (!s.players[1].token || !idle || !fromOk() || seriesDone(s)) return false;
      startGame(s, s.series.results.length, true);
      return true;
    }
    case 'replay': {
      // play the game that just ended again; its result is erased
      if (!s.players[1].token || !fromOk() || !s.game || !s.game.over) return false;
      const idx = s.game.sidx;
      if (idx !== s.series.results.length - 1 || s.series.results[idx].game !== s.current) return false;
      s.series.results.pop();
      startGame(s, idx, true);
      return true;
    }
    case 'menu':
      if (!s.game || !fromOk()) return false;
      s.current = null; s.game = null; s.leftBy = p;
      return true;
    case 'newSeries':
      if (!s.players[1].token || !fromOk()) return false;
      if ('n' in a && a.n !== s.series.n) return false; // both phones pressed at once
      closeSeries(s);
      s.series = { n: s.series.n + 1, results: [] };
      s.current = null; s.game = null; s.leftBy = null;
      return true;
    case 'resetEvening':
      s.evening = [0, 0, 0];
      s.series = { n: 1, results: [] };
      s.current = null; s.game = null; s.leftBy = null;
      return true;
    case 'jump': {
      if (!opts || !opts.test || !Object.prototype.hasOwnProperty.call(BY, a.game)) return false;
      startGame(s, GAMES.indexOf(BY[a.game]), false);
      return true;
    }
    case 'g': {
      if (!s.game || s.game.over) return false;
      if ('gid' in a && a.gid !== s.game.id) return false;
      if (!a.a || typeof a.a !== 'object') return false;
      const G = BY[s.current];
      let ok = false;
      try { ok = G.apply(s.game, a.a, p) === true; } catch { ok = false; }
      if (!ok) return false;
      if (s.game.over && !s.game.counted) {
        s.game.counted = true;
        if (s.game.sidx === s.series.results.length) s.series.results.push({ game: s.current, winner: s.game.over.winner });
      }
      return true;
    }
  }
  return false;
}

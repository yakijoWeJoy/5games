/* Pure shared-state logic (no DOM) – the host phone runs this, tests import it too. */
import { rid } from './ui.js';
import bull from './games/bull.js';
import hangman from './games/hangman.js';
import ships from './games/ships.js';
import dots from './games/dots.js';
import five from './games/five.js';

export const GAMES = [bull, hangman, ships, dots, five];
export const BY = Object.fromEntries(GAMES.map(G => [G.id, G]));

export const cleanName = n => String(n || '').trim().slice(0, 14) || 'שחקן';

export function newState(name, token) {
  return {
    v: 1, rev: 0,
    players: [{ name, token }, { name: null, token: null }],
    score: Object.fromEntries(GAMES.map(G => [G.id, [0, 0, 0]])), // [wins p0, wins p1, ties]
    starter: Object.fromEntries(GAMES.map(G => [G.id, 0])),
    current: null, game: null, lastDone: null, leftBy: null,
    chat: [],
    acks: [], // ids of guest actions already handled (so a re-sent action is never applied twice)
  };
}

const gameId = s => (s.game ? s.game.id : null);

/** Apply action `a` of player `p` to state `s` (mutates). Returns false if the action is not allowed. */
export function reduce(s, p, a) {
  if (!a || typeof a !== 'object' || (p !== 0 && p !== 1)) return false;
  switch (a.k) {
    case 'chat': {
      const text = String(a.text || '').trim().slice(0, 240);
      if (!text) return false;
      s.chat.push({ id: rid(), p, text, t: Date.now() });
      if (s.chat.length > 80) s.chat.splice(0, s.chat.length - 80);
      return true;
    }
    case 'pick': {
      const G = Object.prototype.hasOwnProperty.call(BY, a.game) ? BY[a.game] : null;
      if (!G || !s.players[1].token) return false;
      // `from` = the game the player was looking at; protects against two phones pressing at once
      if ('from' in a && a.from !== gameId(s)) return false;
      const st = s.starter[a.game];
      s.starter[a.game] = 1 - st;
      s.current = a.game;
      s.game = G.init(st);
      s.game.id = rid();
      s.game.counted = false;
      return true;
    }
    case 'menu':
      if (!s.game) return false;
      if ('from' in a && a.from !== gameId(s)) return false;
      s.current = null; s.game = null; s.leftBy = p;
      return true;
    case 'resetScores':
      s.score = Object.fromEntries(GAMES.map(G => [G.id, [0, 0, 0]]));
      s.lastDone = null;
      return true;
    case 'g': {
      if (!s.game || s.game.over) return false;
      if ('gid' in a && a.gid !== s.game.id) return false;
      if (!a.a || typeof a.a !== 'object') return false;
      const G = BY[s.current];
      let ok = false;
      try { ok = G.apply(s.game, a.a, p) === true; } catch { ok = false; }
      if (!ok) return false;
      if (s.game.over && !s.game.counted) {
        const w = s.game.over.winner;
        s.score[s.current][w == null ? 2 : w]++;
        s.game.counted = true;
        s.lastDone = s.current;
      }
      return true;
    }
  }
  return false;
}

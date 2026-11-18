/*
 * Short sounds made on the fly with Web Audio (no sound files to download).
 * Phones only allow sound after the first tap on the page, so the audio is unlocked on the first tap.
 * Every request is recorded in window.__dvSounds (also when muted) so automated tests can check it.
 */
const KEY = 'dv:sound';
let ctx = null;
let on = true;
try { on = localStorage.getItem(KEY) !== 'off'; } catch { /* storage blocked: keep sound on */ }

export const soundOn = () => on;
export function setSound(v) {
  on = !!v;
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
  if (on) unlock();
}

function unlock() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    // iOS: playing one silent sample from inside a tap opens the audio for the rest of the visit
    const b = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = b; src.connect(ctx.destination); src.start(0);
  } catch { /* no audio on this device */ }
}
if (typeof document !== 'undefined') {
  for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) document.addEventListener(ev, unlock, { capture: true, passive: true });
}

function tone(t0, freq, at, dur, type = 'sine', vol = 0.16) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0 + at);
  g.gain.setValueAtTime(0.0001, t0 + at);
  g.gain.exponentialRampToValueAtTime(vol, t0 + at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(t0 + at); o.stop(t0 + at + dur + 0.05);
}

const SOUNDS = {
  // "it's your turn": a soft two-note ding, rising
  turn: t => { tone(t, 660, 0, 0.18, 'triangle', 0.2); tone(t, 990, 0.12, 0.32, 'triangle', 0.2); },
  win: t => { [523, 659, 784, 1047].forEach((f, i) => tone(t, f, i * 0.11, i === 3 ? 0.5 : 0.16, 'triangle', 0.18)); },
  lose: t => { tone(t, 440, 0, 0.22, 'sine', 0.14); tone(t, 330, 0.18, 0.45, 'sine', 0.14); },
  tie: t => { tone(t, 587, 0, 0.2, 'triangle', 0.15); tone(t, 587, 0.2, 0.3, 'triangle', 0.15); },
  note: t => { tone(t, 1175, 0, 0.12, 'sine', 0.1); },
  join: t => { tone(t, 784, 0, 0.14, 'triangle', 0.16); tone(t, 988, 0.1, 0.28, 'triangle', 0.16); },
};

export function play(name) {
  try { (window.__dvSounds = window.__dvSounds || []).push(on ? name : name + ':muted'); } catch { /* ignore */ }
  if (!on || !SOUNDS[name]) return;
  try {
    if (!ctx) unlock();
    if (!ctx || ctx.state !== 'running') return; // not unlocked yet (no tap so far)
    SOUNDS[name](ctx.currentTime + 0.01);
  } catch { /* ignore */ }
}

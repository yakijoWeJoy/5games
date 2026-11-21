/*
 * Interface language: Hebrew when the device's language is Hebrew, English otherwise.
 * ?lang=he|en and the switch on the home screen override it, and the choice is remembered on this device.
 * index.html makes the same decision before anything is drawn (so the page never flips direction),
 * and hands it over in window.__dvLang.
 *
 * Every text is written as T('עברית', 'English'), so both languages sit side by side in the code.
 */
const W = typeof window !== 'undefined' ? window : null;

export function detectLang() {
  if (!W) return 'he'; // node (logic tests)
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'he' || q === 'en') { localStorage.setItem('dv:lang', q); return q; }
  } catch { /* storage blocked */ }
  try {
    const saved = localStorage.getItem('dv:lang');
    if (saved === 'he' || saved === 'en') return saved;
  } catch { /* storage blocked */ }
  const first = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  return /^(he|iw)\b/i.test(first) ? 'he' : 'en';
}

export const LANG = (W && (W.__dvLang === 'he' || W.__dvLang === 'en')) ? W.__dvLang : detectLang();
export const HE = LANG === 'he';
/** pick the text of the current language */
export const T = (he, en) => (HE ? he : en);

/** switch language (remembered) and reload */
export function setLang(lang) {
  try { localStorage.setItem('dv:lang', lang); } catch { /* ignore */ }
  const u = new URL(location.href);
  u.searchParams.delete('lang');
  location.replace(u.toString());
}

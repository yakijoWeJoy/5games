/*
 * "Add to home screen": the game as an app (PWA).
 * Android (Chrome, Samsung, Edge) gives a real install dialog: we keep its event and open it from our button.
 * iPhone has no such dialog: we show the two taps (Share → Add to Home Screen).
 * Inside Instagram / TikTok / Facebook nothing can be installed: we explain how to open the real browser first.
 */
import { h, toast } from './ui.js';
import { T } from './i18n.js';
import { track } from './analytics.js';

const W = window, ua = navigator.userAgent || '';
export const STANDALONE = !!(navigator.standalone || (W.matchMedia && matchMedia('(display-mode: standalone)').matches));
const IOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const IN_APP = /Instagram|FBAN|FBAV|FB_IAB|musical_ly|BytedanceWebview|TikTok|trill_|Line\//.test(ua);
const MOBILE = IOS || /Android|Mobile/.test(ua);
const SNOOZE_KEY = 'dv:install-snooze';
const SNOOZE_DAYS = 7;

let deferred = null; // Android's install dialog, held until the player asks for it
W.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; });
W.addEventListener('appinstalled', () => { deferred = null; track('app_installed', { platform: platform() }, { now: true }); });

/** the offline starter: the app opens even without internet (and then explains that it needs it) */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (/^(localhost|127\.|\[::1\])/.test(location.hostname) && !W.__dvSW) return; // tests opt in explicitly
  navigator.serviceWorker.register('sw.js').catch(() => { /* not important enough to bother anyone */ });
}

export function platform() {
  if (STANDALONE) return 'installed';
  if (IN_APP) return 'in_app';
  if (deferred) return 'android_dialog';
  if (IOS) return 'ios';
  return MOBILE ? 'mobile_other' : 'desktop';
}

/** worth offering on this device right now? (a phone, not installed yet, not snoozed) */
export function canOffer() {
  if (STANDALONE || (!MOBILE && !W.__dvForceInstall)) return false;
  try { return +(localStorage.getItem(SNOOZE_KEY) || 0) < Date.now(); } catch { return true; }
}

const shown = new Set();
function seen(where) { if (!shown.has(where)) { shown.add(where); track('install_offer_shown', { where, platform: platform() }); } }

/** a small link (home screen) */
export function installLink(where) {
  if (!canOffer()) return null;
  seen(where);
  return h('button', { class: 'link-btn install-link', 'data-log': 'install', onclick: () => startInstall(where) }, T('📲 להוסיף את המשחק למסך הבית', '📲 Add the game to your home screen'));
}

/** a card after a finished game: the moment people enjoy it */
export function installCard(where, onClose) {
  if (!canOffer()) return null;
  seen(where);
  return h('div', { class: 'card install-card' },
    h('div', { class: 'install-row' },
      h('img', { src: 'icons/icon-192.png', alt: '', width: 48, height: 48 }),
      h('div', {},
        h('b', {}, T('בפעם הבאה – בלחיצה אחת', 'Next time – one tap')),
        h('div', { class: 'soft' }, T('הוסיפו את דף ועיפרון למסך הבית, כמו אפליקציה', 'Add Paper & Pencil to your home screen, like an app')))),
    h('div', { class: 'row center' },
      h('button', { class: 'btn small marker', 'data-log': 'install', onclick: () => startInstall(where) }, T('📲 הוספה למסך הבית', '📲 Add to home screen')),
      h('button', {
        class: 'link-btn', 'data-log': 'install-later', onclick: () => {
          try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86400000)); } catch { /* ignore */ }
          track('install_snoozed', { where, platform: platform() });
          onClose && onClose();
        },
      }, T('לא עכשיו', 'Not now'))));
}

export async function startInstall(where) {
  const pf = platform();
  track('install_clicked', { where, platform: pf }, { now: true });
  if (deferred) {
    const ev = deferred; deferred = null;
    try {
      await ev.prompt();
      const r = await ev.userChoice;
      track('install_result', { where, outcome: r && r.outcome }, { now: true });
      if (r && r.outcome === 'accepted') toast(T('נוסף למסך הבית ✓', 'Added to your home screen ✓'));
    } catch { howTo(pf, where); }
    return;
  }
  howTo(pf, where);
}

function howTo(pf, where) {
  let title, steps;
  if (pf === 'in_app') {
    title = T('קודם פותחים בדפדפן', 'First, open it in your browser');
    steps = [
      T('כאן אנחנו בתוך האפליקציה (אינסטגרם / טיקטוק), ומכאן אי אפשר להוסיף למסך הבית.', 'You\'re inside an app (Instagram / TikTok), and it can\'t add things to your home screen.'),
      T('לוחצים על ⋯ או ⋮ למעלה, ובוחרים "פתיחה בדפדפן" (Open in browser).', 'Tap ⋯ or ⋮ at the top and choose "Open in browser".'),
      T('שם לוחצים שוב על "הוספה למסך הבית".', 'Then tap "Add to home screen" again there.'),
    ];
  } else if (pf === 'ios') {
    title = T('הוספה למסך הבית באייפון', 'Add to your iPhone home screen');
    steps = [
      T('לוחצים על כפתור השיתוף ⬆ (בתחתית או בראש המסך).', 'Tap the Share button ⬆ (at the bottom or top of the screen).'),
      T('גוללים ובוחרים "הוספה למסך הבית" ➕.', 'Scroll and choose "Add to Home Screen" ➕.'),
      T('לוחצים "הוספה" – והאייקון ✏️ מופיע במסך הבית.', 'Tap "Add" – the ✏️ icon appears on your home screen.'),
    ];
  } else {
    title = T('הוספה למסך הבית', 'Add to your home screen');
    steps = [
      T('פותחים את התפריט של הדפדפן (⋮ או ☰).', 'Open the browser menu (⋮ or ☰).'),
      T('בוחרים "הוספה למסך הבית" או "התקנת אפליקציה".', 'Choose "Add to Home screen" or "Install app".'),
      T('מאשרים – והאייקון ✏️ מופיע במסך הבית.', 'Confirm – the ✏️ icon appears on your home screen.'),
    ];
  }
  track('install_howto_shown', { where, platform: pf });
  const bg = h('div', { class: 'modal-bg' });
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  bg.append(h('div', { class: 'modal card help-card install-howto', role: 'dialog', 'aria-label': title },
    h('h3', {}, title),
    h('ol', { class: 'help-list' }, steps.map(s => h('li', {}, s))),
    pf === 'in_app' ? h('button', {
      class: 'btn small', 'data-log': 'install-copy', onclick: async () => {
        try { await navigator.clipboard.writeText(location.origin + location.pathname); toast(T('הקישור הועתק – הדביקו בדפדפן 📋', 'Link copied – paste it in your browser 📋')); } catch { /* ignore */ }
      },
    }, T('📋 העתקת הקישור', '📋 Copy the link')) : null,
    h('button', { class: 'btn marker', onclick: close }, T('הבנתי ✓', 'Got it ✓'))));
  document.body.append(bg);
}

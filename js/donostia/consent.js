import { t, onLang } from './i18n.js';

// js/donostia/consent.js
// The cookie choice for the usage analytics (js/donostia/analytics.js): a small card, a moment after the city first
// shows and until it is answered (its Basque and Spanish titles offer a teja with the coffee, the curved almond
// biscuit of Tolosa; the card itself draws none). The first button sets PostHog's first-party cookie, so the same visitor
// is the same person tomorrow; the second keeps the cookieless hash: counted, never recognised, which is also how it
// is until the card is answered. Either answer is remembered (localStorage) and the card does not come back; the data
// popover shows the answer with a button to choose again, which brings the card back.
//
// Where it sits is css/donostia.css's (.hud-consent): over the controls hint on a desktop, in the middle beside the
// stick on a tablet or a phone on its side, and above the stick on an upright phone, clear of the bar.
// It does not wait for the background compile ("Loading details…", js/donostia/main.js): that can take a minute on a
// phone, its note sits under the card and the two do not touch.
//
// Its words are js/donostia/i18n.js's: the card's and the popover's own by index.html's data-i18n marks, the answer's
// line written here and again when the language changes.
//
// initConsent(tracker, doc, { delay }) -> { setReady(), shown }: main.js calls setReady() as the loading screen lifts
// (the card never shows over it), and the card follows `delay` ms later (SHOW_AFTER_MS: the city is seen first). The
// elements: #consent-card with #consent-accept and #consent-decline; in the popover #consent-line with #consent-state
// and #consent-change.

export const SHOW_AFTER_MS = 2500;

// the tracker's status -> the answer's line in the data popover
const STATE = { granted: 'consent.granted', denied: 'consent.denied', pending: 'consent.pending' };

export function initConsent(tracker, doc = document, { delay = SHOW_AFTER_MS } = {}) {
  const card = doc.getElementById('consent-card');
  const line = doc.getElementById('consent-line');
  const state = doc.getElementById('consent-state');
  let ready = false, reopened = false;
  const render = () => {
    const status = tracker.consentStatus;
    if (card) card.hidden = !(ready && status !== 'none' && (status === 'pending' || reopened));
    if (line) line.hidden = status === 'none';
    if (state) state.textContent = STATE[status] ? t(STATE[status]) : '';
  };
  const decide = (cookies) => {
    reopened = false;
    tracker.decide(cookies);
    render(); // (the tracker's listeners render too; this covers a tracker without a notify)
  };
  doc.getElementById('consent-accept')?.addEventListener('click', () => decide(true));
  doc.getElementById('consent-decline')?.addEventListener('click', () => decide(false));
  doc.getElementById('consent-change')?.addEventListener('click', () => {
    reopened = true;
    ready = true; // (asked for by hand: no wait)
    doc.getElementById('credits-popover')?.hidePopover?.();
    render();
  });
  tracker.onConsent(render);
  onLang(render);
  render();
  return {
    setReady() {
      const show = () => { ready = true; render(); };
      if (delay > 0) setTimeout(show, delay);
      else show();
    },
    get shown() { return Boolean(card) && !card.hidden; }
  };
}

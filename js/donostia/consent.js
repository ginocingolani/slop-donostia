// js/donostia/consent.js
// The cookie choice for the usage analytics (js/donostia/analytics.js): a small card over the controls hint once the
// city shows, until it is answered. "Bai" sets PostHog's first-party cookie, so the same visitor is the same person
// tomorrow; "Ez" keeps the cookieless hash: counted, never recognised, which is also how it is until the card is
// answered. The answer is remembered (localStorage), and the data popover (ⓘ) shows it with a button to choose again,
// which brings the card back.
//
// initConsent(tracker, doc) -> { setReady() }: main.js calls setReady() as the loading screen lifts (the card never
// shows over it). The elements: #consent-card with #consent-accept and #consent-decline; in the popover #consent-line
// with #consent-state and #consent-change.

const STATE = { granted: 'bai · sí (cookie)', denied: 'ez · no (sin cookie)', pending: 'galdetu gabe · sin responder (sin cookie)' };

export function initConsent(tracker, doc = document) {
  const card = doc.getElementById('consent-card');
  const line = doc.getElementById('consent-line');
  const state = doc.getElementById('consent-state');
  let ready = false, reopened = false;
  const render = () => {
    const status = tracker.consentStatus;
    if (card) card.hidden = !(ready && status !== 'none' && (status === 'pending' || reopened));
    if (line) line.hidden = status === 'none';
    if (state) state.textContent = STATE[status] ?? '';
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
    doc.getElementById('credits-popover')?.hidePopover?.();
    render();
  });
  tracker.onConsent(render);
  render();
  return {
    setReady() {
      ready = true;
      render();
    },
    get shown() { return Boolean(card) && !card.hidden; }
  };
}

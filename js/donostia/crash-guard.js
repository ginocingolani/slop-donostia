// js/donostia/crash-guard.js
// Whether the last visit died, so that this one can start lighter and no visitor is left in a crash loop.
//
// A phone's browser kills a page that takes too much memory without a word: no error, no event, and then it loads
// the page again. If the city asks for the same on every load (a heavy tier stored from an earlier visit), the page
// dies again in the same place and the visitor never reaches the settings to change it: an iPhone 15 Pro with ultra
// stored died in the shader compile four loads in a row. Nothing in the dying page can report it, so the page leaves
// a note while it is alive and the next load reads it.
//
// The note (localStorage, RUN_KEY: the one thing sure to survive the reload) is written when the boot starts, brought
// up to date at every step of the load and every few seconds once the city shows (the heartbeat), and marked as left
// on `pagehide` (a reload, a closed tab, a navigation: the clean ways out). A load that finds a note still marked
// live knows the page that wrote it never left: assess() says what to make of it.
//
// What counts as a death, and what does not:
// - the note says the page was hidden when last written (the tab or the browser in the background, the phone
//   locked): not counted. Browsers kill background tabs as a matter of course, and a tab closed from the tab switcher
//   or an app swiped away is hidden first; a phone often sends no `pagehide` for those;
// - the note is older than WINDOW_MS: not counted, and the count of failures starts again. A crash loop is reloads
//   within seconds, a visitor who comes back after a crash does so within minutes; a note from yesterday is more
//   likely a browser that was killed with the page open;
// - on a desktop, a fresh note (under STALE_MS) from another tab: not counted, that tab is alive in another window.
//   The same tab is known by an id in sessionStorage, which a reload keeps; on a phone or tablet only one tab shows
//   at a time (and a hidden one says so), so a live, visible note is the dead page's whichever tab reads it;
// - a load the visitor gave up on (closed the tab, went elsewhere, reloaded) sends `pagehide`: it is neither a
//   failure nor a success, and the count stands as it was;
// - everything else: the page died in view, loading (`shown` false) or running. What cannot be told apart from it:
//   a browser killed or crashed with the city in view, and a tab closed without `pagehide` or `visibilitychange`,
//   when the visitor is back within WINDOW_MS. Those cost one lighter start.
//
// What follows from a death (js/donostia/quality.js's init({ recovery }) and js/donostia/main.js):
// - `fails` counts the boots that died in a row; the city showing sets it back to 0, so a page that dies while
//   running counts 1. The next boot is a tier under the one that died, and the lowest after two in a row;
// - a stored pick does not override that, and is dropped (`dropPick`) once it has died twice: two boots in a row, or
//   twice at the picked tier with good visits at lower ones in between (`pickFails`, kept across those);
// - `halt`: two or more in a row and the last at the lowest tier. The page then stops trying: main.js shows the
//   loading screen's message with a button, which calls retry() (one more boot at the lowest tier; if that dies too,
//   the message again). The note is left as it is meanwhile, so a reload shows the message, not another attempt,
//   until WINDOW_MS has passed.
//
// No DOM in here: createCrashGuard() takes its storages and its clock, and tests/donostia-crash-guard.test.mjs runs
// the sequences in node.

export const RUN_KEY = 'donostia-run'; // localStorage: the note, JSON (see begin())
export const TAB_KEY = 'donostia-tab'; // sessionStorage: this tab's id
export const WINDOW_MS = 30 * 60 * 1000; // a note older than this says nothing about this visit
export const STALE_MS = 20 * 1000; // a live page writes its note more often than this (see BEAT_MS)
export const BEAT_MS = 1000; // the least time between two heartbeats written
const LOWEST = 'low';

/**
 * What to make of the note the last load left (null: none). { now, tabId (this tab's, null if unknown), mobile }.
 * Returns { failed (the last visit died in view: a new failure), reason: 'none' | 'left' | 'hidden' | 'old' |
 * 'other-tab' | 'loading' | 'running', fails (failed boots in a row, this one included), failedTier (the tier that
 * died last, null if none), lastStage, lastLive (real time was on), shown, ranMs (from its boot to its last
 * heartbeat), agoMs (since that heartbeat), sameTab, pick & pickFails (the stored pick's failures so far), dropPick,
 * halt }. With fails > 0 the next boot is to be lighter, whether the failure is new or an earlier one still stands
 * (a recovery boot the visitor left before the city showed).
 */
export function assess(note, { now = Date.now(), tabId = null, mobile = false } = {}) {
  const out = {
    failed: false, reason: 'none', fails: 0, failedTier: null, lastStage: null, lastLive: null, shown: false, ranMs: 0, agoMs: 0,
    sameTab: false, pick: null, pickFails: 0, dropPick: false, halt: false
  };
  if (!note || typeof note !== 'object') return out;
  const fails = Number.isFinite(note.fails) && note.fails > 0 ? Math.floor(note.fails) : 0;
  const agoMs = Math.max(0, now - (Number(note.t) || 0));
  Object.assign(out, {
    agoMs, pick: note.pick ?? null, pickFails: Number.isFinite(note.pickFails) && note.pickFails > 0 ? Math.floor(note.pickFails) : 0,
    lastStage: note.stage ?? null, lastLive: note.realTime ?? null, shown: Boolean(note.shown), ranMs: Math.max(0, (Number(note.t) || 0) - (Number(note.t0) || Number(note.t) || 0)),
    sameTab: Boolean(tabId) && note.id === tabId
  });
  const carried = () => { out.fails = fails; out.failedTier = fails ? note.failedTier ?? null : null; };
  if (agoMs > WINDOW_MS) {
    out.reason = note.live ? 'old' : 'none';
  } else if (!note.live) {
    // left cleanly: an earlier failure still stands if the city never showed since
    out.reason = 'left';
    carried();
  } else if (note.hidden) {
    out.reason = 'hidden';
    carried();
  } else if (!out.sameTab && !mobile && agoMs < STALE_MS) {
    out.reason = 'other-tab';
    carried();
  } else {
    out.failed = true;
    out.reason = note.shown ? 'running' : 'loading';
    out.fails = fails + 1;
    out.failedTier = note.tier ?? null;
    // (the stored pick's own count: a boot at the picked tier, not one already lowered for an earlier failure)
    if (note.pick && note.tier === note.pick) out.pickFails++;
  }
  out.dropPick = out.fails >= 2 || out.pickFails >= 2;
  out.halt = out.fails >= 2 && out.failedTier === LOWEST;
  return out;
}

const parse = (text) => { try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; } };

/**
 * The guard of one page load. storage: localStorage (or null); session: sessionStorage (or null); mobile: a phone or
 * tablet (js/donostia/quality.js's detectTier().mobile). Reads and assesses the last load's note at once:
 *   guard.previous                 assess()'s answer
 *   guard.begin({ tier, mode, pick, hidden })   the boot starts: the note is this load's from here on (pick: the
 *                                  stored pick in force, or null)
 *   guard.stage(name)              a step of the load is done (or, later, 'ready', 'applying', 'details_ready')
 *   guard.beat({ tier, realTime }) the heartbeat (written at most every BEAT_MS): still alive, at this tier
 *   guard.shown()                  the city shows: the boot succeeded
 *   guard.hidden(on)               the page went to the background, or came back
 *   guard.leave()                  `pagehide`: a clean way out
 *   guard.resume()                 back from the back/forward cache: alive again
 *   guard.retry()                  the halted message's button: one more boot at the lowest tier
 * Nothing is written before begin(), so a page that halts on the last note leaves it as it found it.
 */
export function createCrashGuard({ storage = null, session = null, mobile = false, now = () => Date.now() } = {}) {
  const read = (store, key) => { try { return store?.getItem(key) ?? null; } catch { return null; } };
  const write = (store, key, value) => {
    try {
      if (value == null) store?.removeItem(key);
      else store?.setItem(key, value);
    } catch { /* storage unavailable or full */ }
  };
  let tabId = read(session, TAB_KEY);
  const previous = assess(parse(read(storage, RUN_KEY)), { now: now(), tabId, mobile });
  if (!tabId) {
    tabId = Math.random().toString(36).slice(2, 10);
    write(session, TAB_KEY, tabId);
  }
  let note = null, written = 0;
  const save = () => {
    if (!note) return;
    note.t = written = now();
    write(storage, RUN_KEY, JSON.stringify(note));
  };

  return {
    previous,
    get note() { return note && { ...note }; },

    begin({ tier, mode = 'auto', pick = null, hidden = false } = {}) {
      // The pick whose failures are counted: the one in force, or the one this boot does not obey because it died
      // (still stored, to be tried again once a visit has gone well). Another pick starts its own count
      const counted = pick ?? (previous.dropPick ? null : previous.pick);
      note = {
        v: 1, id: tabId, live: true, tier, mode, stage: 'start', shown: false, hidden: Boolean(hidden), realTime: null, t0: now(), t: 0,
        fails: previous.fails, failedTier: previous.failedTier,
        pick: counted, pickFails: counted && counted === previous.pick ? previous.pickFails : 0
      };
      save();
    },

    stage(name) {
      if (!note) return;
      note.stage = name;
      save();
    },

    beat({ tier, realTime } = {}) {
      if (!note || !note.live) return;
      if (tier) note.tier = tier;
      if (realTime != null) note.realTime = Boolean(realTime);
      if (now() - written >= BEAT_MS) save();
    },

    shown() {
      if (!note) return;
      note.shown = true;
      note.stage = 'ready';
      note.fails = 0;
      note.failedTier = null;
      save();
    },

    hidden(on) {
      if (!note || !note.live) return;
      note.hidden = Boolean(on);
      save();
    },

    leave() {
      if (!note) return;
      note.live = false;
      // a good visit at the picked tier clears the pick's count; one at a lower tier keeps it for the next try
      if (note.shown && note.pick && note.tier === note.pick) note.pickFails = 0;
      // (nothing left to remember: no note at all)
      if (note.shown && !note.pickFails) { write(storage, RUN_KEY, null); return; }
      save();
    },

    resume() {
      if (!note) return;
      note.live = true;
      note.hidden = false;
      save();
    },

    retry() {
      write(storage, RUN_KEY, JSON.stringify({ v: 1, id: tabId, live: false, tier: LOWEST, fails: 1, failedTier: LOWEST, pick: null, pickFails: 0, t: now() }));
    }
  };
}

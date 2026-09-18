// ==UserScript==
// @name         Canvas - Grade Watcher
// @namespace    https://github.com/Silverarmor/Userscripts
// @version      2.3.0
// @description  Watch any assignment on a Canvas grades page: notifies when it is graded (planner API), when the score is posted, or when the course Total changes.
// @author       Silverarmor
// @match        https://canvas.auckland.ac.nz/courses/*/grades*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-grade-watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-grade-watcher.user.js
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
  HOW IT WORKS
  ------------
  Open any course's grades page (https://canvas.auckland.ac.nz/courses/<id>/grades)
  and click the badge in the bottom-right corner to pick which assignment to watch
  (the list comes from the #submission_<id> rows on the page; name, points possible
  and due date are then fetched from the assignments API and stored per course).
  Shift-click the badge, or use Tampermonkey's menu, to change assignment later;
  the picker's "Stop watching" button (also in the menu) clears the selection and
  stops polling entirely.

  Leave the tab open. Every POLL_SECONDS the script, without reloading the page:

    1. Calls /api/v1/planner/items (same call as Excigma's assignment-status.js) and
       reads submissions.graded for the watched plannable_id. This flips to true when
       the marker has entered a grade, even while it is still hidden from students.

    2. Calls /api/v1/courses/<course>/assignments/<assignment>/submissions/self and
       reads workflow_state, graded_at, posted_at, and score. A change in
       workflow_state (e.g. submitted -> graded) or graded_at also triggers a
       notification.

    3. Re-fetches the grades page HTML and parses #submission_<assignment>:
       data-muted, and the score in .assignment_score .grade (an icon-off placeholder
       until posted, then the server-rendered number, e.g. 23.5, next to "/ 25").

    4. Calls /api/v1/courses/<course>/enrollments?user_id=self and reads
       grades.current_score, which is the course Total shown on the page.
       (The Total in the raw page HTML is only a placeholder; Canvas fills it in with JS.)

  Note: Chrome throttles main-thread timers in background tabs to ~once a minute
  after ~5 min hidden, so the interval runs in a small Web Worker instead — worker
  timers are exempt, keeping the full 15 s cadence with the tab unfocused. If the
  site's CSP ever blocks blob: workers it falls back to a plain setInterval
  (throttled to ~1/min in the background, changes caught up to a minute late).
  Tab *discarding* (Chrome Memory Saver) still stops the script entirely — add
  the Canvas site under chrome://settings/performance "Always keep these sites
  active" on result day.
  Avoid Safari: it throttles background tabs at the process level (workers too).

  Any change to graded / posted score / Total fires a desktop notification, a sound,
  and a flashing tab title. The last-seen state is stored with GM_setValue so a page
  reload does not re-notify you for something you already know about.

  Once the score is released (a number is visible on the grades page) the script
  keeps polling for another hour, since comments and feedback often come out in
  the minutes after release (release time is posted_at when the API provides it,
  otherwise when the score was first seen). After that it stops — the badge shows
  the final score, and clicking it still polls on demand.

  Click the badge to poll immediately, or to grant browser notification permission
  the first time. Right-click it to fire a test notification (desktop notification
  + beep + flashing tab title).
*/

(function () {
  'use strict';

  // ---------- Config ----------
  const POLL_SECONDS = 15;
  const POST_RELEASE_WATCH_MS = 60 * 60 * 1000; // keep polling this long after release for late feedback

  const COURSE_ID = Number((location.pathname.match(/\/courses\/(\d+)/) || [])[1]);
  const WATCH_KEY = `gradeWatcher:${COURSE_ID}:watched`;

  // Set from the stored watch config in startWatching().
  let ASSIGNMENT_ID = null;
  let ASSIGNMENT_NAME = null;
  let POINTS_POSSIBLE = null;
  let DUE_DATE = null; // used to build a narrow planner window
  let STORAGE_KEY = null;

  const GRADES_URL = `/courses/${COURSE_ID}/grades`;
  const submissionUrl = () => `/api/v1/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}/submissions/self`;
  const ENROLLMENT_URL = `/api/v1/courses/${COURSE_ID}/enrollments?user_id=self&type[]=StudentEnrollment`;

  // ---------- Small helpers ----------
  const log = (...a) => console.log(`[GradeWatcher ${new Date().toLocaleTimeString()}]`, ...a);

  function isoDaysFrom(base, days) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString();
  }

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    // Canvas prefixes JSON with "while(1);" on some endpoints
    const text = await res.text();
    return JSON.parse(text.replace(/^while\(1\);/, ''));
  }

  async function fetchHtml(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  function loadState() {
    try { return JSON.parse(GM_getValue(STORAGE_KEY, 'null')); } catch { return null; }
  }
  function saveState(s) { GM_setValue(STORAGE_KEY, JSON.stringify(s)); }

  // ---------- Signal 1: planner API (graded: true even while hidden) ----------
  async function checkPlanner() {
    // A narrow window around the due date when known, otherwise a wide one around today.
    const base = DUE_DATE || new Date().toISOString();
    const span = DUE_DATE ? 7 : 60;
    const start = isoDaysFrom(base, -span);
    const end = isoDaysFrom(base, +span);
    const items = await fetchJson(
      `/api/v1/planner/items?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&per_page=100`
    );
    const item = items.find(i => i.plannable_type === 'assignment' && i.plannable_id === ASSIGNMENT_ID);
    if (!item) {
      log('Planner: assignment not in window (may have been unmarked/moved). Items:', items.length);
      return { graded: null, needsGrading: null, hasFeedback: null };
    }
    const s = item.submissions || {};
    return {
      graded: !!s.graded,
      needsGrading: !!s.needs_grading,
      hasFeedback: !!s.has_feedback,
    };
  }

  // ---------- Signal 2: submission API (extra info, logged) ----------
  async function checkSubmission() {
    try {
      const sub = await fetchJson(submissionUrl());
      return {
        workflowState: sub.workflow_state ?? null,
        gradedAt: sub.graded_at ?? null,
        postedAt: sub.posted_at ?? null,
        apiScore: sub.score ?? null,
      };
    } catch (e) {
      log('Submission API failed (non-fatal):', e.message);
      return { workflowState: null, gradedAt: null, postedAt: null, apiScore: null };
    }
  }

  // ---------- Signal 3: grades page HTML (posted score + Total) ----------
  function parseGradesDoc(doc) {
    const row = doc.querySelector(`#submission_${ASSIGNMENT_ID}`);
    let muted = null, score = null, scoreText = null;
    if (row) {
      muted = row.getAttribute('data-muted') === 'true';
      const gradeEl = row.querySelector('.assignment_score .grade');
      if (gradeEl) {
        // Drop tooltip text ("Instructor has not posted this grade") before reading
        const clone = gradeEl.cloneNode(true);
        clone.querySelectorAll('.tooltip_wrap, .screenreader-only').forEach(n => n.remove());
        scoreText = clone.textContent.replace(/\s+/g, ' ').trim();
        const hasPlaceholder = !!gradeEl.querySelector('.icon-off');
        const num = parseFloat(scoreText.replace(',', '.'));
        if (!hasPlaceholder && Number.isFinite(num)) score = num;
      }
    }
    return { rowFound: !!row, muted, score, scoreText };
  }

  async function checkGradesPage() {
    return parseGradesDoc(await fetchHtml(GRADES_URL));
  }

  // ---------- Signal 4: enrolments API (course Total, e.g. 99.08%) ----------
  // The Total on the grades page is computed client-side, so the raw HTML only has a
  // placeholder. grades.current_score from the enrolments API is the same number.
  async function checkTotal() {
    const enr = await fetchJson(ENROLLMENT_URL);
    const g = (enr.find(e => e.type === 'StudentEnrollment') || enr[0] || {}).grades || {};
    return {
      total: g.current_score != null ? `${g.current_score}%` : null,
      totalGrade: g.current_grade ?? null,
    };
  }

  // ---------- Notifications ----------
  function notify(title, body) {
    log('NOTIFY:', title, body);
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title, text: body, timeout: 0, onclick: () => window.focus() });
      } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    } catch (e) { log('Notification failed:', e.message); }
    beep();
    flashTitle(title);
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.15;
      o.start(); o.stop(ctx.currentTime + 0.35);
    } catch { /* autoplay policy may block; ignore */ }
  }

  let flashTimer = null;
  const originalTitle = document.title;
  function flashTitle(msg) {
    if (flashTimer) clearInterval(flashTimer);
    let on = false;
    flashTimer = setInterval(() => {
      document.title = (on = !on) ? `🔔 ${msg}` : originalTitle;
    }, 1000);
    const stop = () => { clearInterval(flashTimer); flashTimer = null; document.title = originalTitle; };
    window.addEventListener('focus', stop, { once: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) stop(); }, { once: true });
  }

  // ---------- Watched-assignment config + picker ----------
  function loadWatched() {
    try { return JSON.parse(GM_getValue(WATCH_KEY, 'null')); } catch { return null; }
  }
  function saveWatched(w) { GM_setValue(WATCH_KEY, JSON.stringify(w)); }

  function startWatching(w) {
    ASSIGNMENT_ID = w.assignmentId;
    ASSIGNMENT_NAME = w.name;
    POINTS_POSSIBLE = w.pointsPossible ?? '?';
    DUE_DATE = w.dueAt ?? null;
    STORAGE_KEY = `gradeWatcher:${COURSE_ID}:${ASSIGNMENT_ID}`;
    log(`Watching "${ASSIGNMENT_NAME}" (assignment ${ASSIGNMENT_ID})`);
    if (ticker) ticker.stop();
    poll();
    ticker = startTicker();
  }

  function stopWatching() {
    if (ticker) { ticker.stop(); ticker = null; }
    saveWatched(null);
    ASSIGNMENT_ID = ASSIGNMENT_NAME = POINTS_POSSIBLE = DUE_DATE = STORAGE_KEY = null;
    log('Stopped watching — no assignment selected.');
    setBadge('Grade Watcher: click to choose an assignment', '#666');
  }

  // The grades page renders one tr#submission_<numeric id> per real assignment
  // (group/total rows have non-numeric suffixes and are skipped).
  function listAssignmentsOnPage() {
    return [...document.querySelectorAll('tr[id^="submission_"]')]
      .map(row => {
        const m = row.id.match(/^submission_(\d+)$/);
        const title = row.querySelector('th.title a')?.textContent.trim();
        return m && title ? { id: Number(m[1]), title } : null;
      })
      .filter(Boolean);
  }

  let picker = null;
  function openPicker() {
    if (picker) { picker.remove(); picker = null; }
    const options = listAssignmentsOnPage();
    if (!options.length) {
      notify('Grade Watcher', 'No assignment rows found on this page — open the course grades page first.');
      return;
    }
    picker = document.createElement('div');
    Object.assign(picker.style, {
      position: 'fixed', right: '12px', bottom: '48px', zIndex: 99999,
      padding: '10px', borderRadius: '6px', background: '#fff', color: '#000',
      fontFamily: 'system-ui, sans-serif', fontSize: '13px',
      boxShadow: '0 2px 10px rgba(0,0,0,.35)', display: 'flex', gap: '6px', alignItems: 'center',
    });
    const select = document.createElement('select');
    select.style.maxWidth = '260px';
    options.forEach(o => {
      const opt = document.createElement('option');
      opt.value = String(o.id);
      opt.textContent = o.title;
      select.appendChild(opt);
    });
    if (ASSIGNMENT_ID) select.value = String(ASSIGNMENT_ID);
    const watchBtn = document.createElement('button');
    watchBtn.textContent = 'Watch';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Cancel';
    picker.append(select, watchBtn);
    if (ASSIGNMENT_ID) {
      const stopBtn = document.createElement('button');
      stopBtn.textContent = 'Stop watching';
      stopBtn.addEventListener('click', () => {
        picker.remove(); picker = null;
        stopWatching();
      });
      picker.append(stopBtn);
    }
    picker.append(cancelBtn);
    document.body.appendChild(picker);

    cancelBtn.addEventListener('click', () => { picker.remove(); picker = null; });
    watchBtn.addEventListener('click', async () => {
      const id = Number(select.value);
      watchBtn.disabled = true;
      try {
        // Authoritative name/points/due date, so nothing needs hardcoding.
        const a = await fetchJson(`/api/v1/courses/${COURSE_ID}/assignments/${id}`);
        const w = {
          assignmentId: id,
          name: a.name || options.find(o => o.id === id)?.title || `Assignment ${id}`,
          pointsPossible: a.points_possible ?? null,
          dueAt: a.due_at ?? null,
        };
        saveWatched(w);
        picker.remove(); picker = null;
        startWatching(w);
      } catch (e) {
        log('Assignment lookup failed:', e.message);
        watchBtn.disabled = false;
      }
    });
  }

  // ---------- Poll ticker ----------
  // Chrome batches main-thread timers in hidden tabs to ~1/min after 5 minutes
  // ("intensive throttling"), but dedicated Web Worker timers are exempt, and so
  // is the message-event handler they wake. Running the interval in a tiny Blob
  // worker keeps the full 15 s cadence in background tabs. Falls back to a plain
  // (throttleable) setInterval if the site's CSP blocks blob: workers.
  let ticker = null;

  function startTicker() {
    try {
      const url = URL.createObjectURL(new Blob(
        [`setInterval(() => postMessage(0), ${POLL_SECONDS * 1000});`],
        { type: 'text/javascript' }
      ));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = () => poll();
      log('Worker ticker running — polling is not throttled in background tabs.');
      return { stop: () => worker.terminate() };
    } catch (e) {
      log('Worker ticker unavailable (CSP?), falling back to setInterval:', e.message);
      const id = setInterval(poll, POLL_SECONDS * 1000);
      return { stop: () => clearInterval(id) };
    }
  }

  // ---------- Diff + main poll ----------
  function describe(s) {
    const sc = s.score != null ? `${s.score}/${POINTS_POSSIBLE}` : (s.muted ? 'hidden' : 'none');
    return `graded=${s.graded} needsGrading=${s.needsGrading} score=${sc} total=${s.total} muted=${s.muted}`;
  }

  async function poll(manual = false) {
    if (!ASSIGNMENT_ID) return;
    setBadge('polling…', '#999');
    const prev = loadState();
    const [planner, page, sub, tot] = await Promise.all([
      checkPlanner().catch(e => { log('Planner failed:', e.message); return null; }),
      checkGradesPage().catch(e => { log('Grades page failed:', e.message); return null; }),
      checkSubmission(),
      checkTotal().catch(e => { log('Enrolments failed:', e.message); return null; }),
    ]);
    if (!planner && !page && !tot) { setBadge('error, retrying', '#c33'); return; }

    const now = {
      checkedAt: new Date().toISOString(),
      graded: planner ? planner.graded : prev?.graded ?? null,
      needsGrading: planner ? planner.needsGrading : prev?.needsGrading ?? null,
      hasFeedback: planner ? planner.hasFeedback : prev?.hasFeedback ?? null,
      muted: page ? page.muted : prev?.muted ?? null,
      score: page ? page.score : prev?.score ?? null,
      total: tot ? tot.total : prev?.total ?? null,
      totalGrade: tot ? tot.totalGrade : prev?.totalGrade ?? null,
      ...sub,
    };
    log(describe(now), sub);

    if (prev) {
      const changes = [];
      if (now.graded === true && prev.graded !== true)
        changes.push(`Graded in Canvas (still hidden until posted)`);
      if (now.score != null && prev.score !== now.score)
        changes.push(`Score posted: ${now.score}/${POINTS_POSSIBLE}`);
      if (now.total && prev.total && now.total !== prev.total)
        changes.push(`Total changed: ${prev.total} → ${now.total}`);
      if (now.muted === false && prev.muted === true)
        changes.push(`Grade unmuted (posted)`);
      if (now.hasFeedback && !prev.hasFeedback)
        changes.push(`Feedback added`);
      if (now.postedAt && !prev.postedAt)
        changes.push(`posted_at set: ${now.postedAt}`);
      if (now.workflowState && prev.workflowState && now.workflowState !== prev.workflowState)
        changes.push(`Submission state: ${prev.workflowState} → ${now.workflowState}`);
      if (now.gradedAt && prev.gradedAt && now.gradedAt !== prev.gradedAt)
        changes.push(`graded_at changed: ${prev.gradedAt} → ${now.gradedAt}`);

      if (changes.length) {
        notify(`${ASSIGNMENT_NAME}: ${changes[0]}`, changes.join('\n'));
      } else if (manual) {
        log('No change since last check.');
      }
    } else {
      log('First run, baseline stored:', describe(now));
    }
    // Score released: comments/feedback often trickle in shortly afterwards, so
    // keep watching for POST_RELEASE_WATCH_MS past the release before stopping
    // the auto-poll. Manual badge clicks still poll on demand.
    const released = now.score != null;
    now.releaseSeenAt = prev?.releaseSeenAt ?? (released ? (now.postedAt ?? now.checkedAt) : null);
    saveState(now);

    const watchUntil = now.releaseSeenAt
      ? new Date(now.releaseSeenAt).getTime() + POST_RELEASE_WATCH_MS
      : null;
    const stopped = watchUntil != null && Date.now() > watchUntil;
    if (stopped && ticker) {
      ticker.stop();
      ticker = null;
      log(`Released over ${POST_RELEASE_WATCH_MS / 60000} min ago — automatic polling stopped.`);
    }

    setBadge(
      `${ASSIGNMENT_NAME}: ${now.graded ? 'GRADED' : 'not graded'} · ` +
      `${released ? now.score + '/' + POINTS_POSSIBLE : 'hidden'} · Total ${now.total ?? '?'} · ` +
      `${stopped ? 'released, polling stopped'
        : released ? `released, watching feedback until ${new Date(watchUntil).toLocaleTimeString()}`
        : new Date().toLocaleTimeString()}`,
      released ? '#2a2' : now.graded ? '#e80' : '#38c'
    );
  }

  // ---------- Tiny status badge ----------
  let badge;
  function setBadge(text, colour) {
    if (!badge) {
      badge = document.createElement('div');
      Object.assign(badge.style, {
        position: 'fixed', right: '12px', bottom: '12px', zIndex: 99999,
        padding: '6px 10px', borderRadius: '6px', fontSize: '12px', color: '#fff',
        fontFamily: 'system-ui, sans-serif', cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,.3)',
      });
      badge.title =
        `Click to check now (auto every ${POLL_SECONDS} s) · ` +
        `Shift-click to change assignment · Right-click to test notifications`;
      badge.addEventListener('click', (e) => {
        if (!ASSIGNMENT_ID || e.shiftKey) { openPicker(); return; }
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        poll(true);
      });
      badge.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        notify(`${ASSIGNMENT_NAME ?? 'Grade Watcher'}: test notification`, 'If you can see this, notifications are working.');
      });
      document.body.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.background = colour;
  }

  // ---------- Start ----------
  if (!COURSE_ID) return; // not a course page

  if ('Notification' in window && Notification.permission === 'default') {
    // Permission requests need a user gesture; the badge click handles it.
    log('Click the badge once to allow browser notifications (GM_notification works without it).');
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Choose assignment to watch', openPicker);
    GM_registerMenuCommand('Stop watching', stopWatching);
  }

  const watched = loadWatched();
  if (watched) {
    startWatching(watched);
  } else {
    setBadge('Grade Watcher: click to choose an assignment', '#666');
  }
})();

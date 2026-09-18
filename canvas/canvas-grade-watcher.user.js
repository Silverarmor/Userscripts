// ==UserScript==
// @name         Canvas - Grade Watcher (ENGGEN 403 Team Project)
// @namespace    https://github.com/Silverarmor/Userscripts
// @version      1.0.0
// @description  Polls Canvas and notifies when the Team Project is graded (planner API), when the score is posted (xx/25 on the grades page), or when the course Total changes.
// @author       Silverarmor
// @match        https://canvas.auckland.ac.nz/courses/142383/grades*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-grade-watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-grade-watcher.user.js
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

/*
  HOW IT WORKS
  ------------
  Leave the ENGGEN 403 grades page (https://canvas.auckland.ac.nz/courses/142383/grades)
  open in a tab. Every POLL_SECONDS the script, without reloading the page:

    1. Calls /api/v1/planner/items (same call as Excigma's assignment-status.js) and
       reads submissions.graded for plannable_id 520785. This flips to true when the
       marker has entered a grade, even while it is still hidden from students.

    2. Calls /api/v1/courses/142383/assignments/520785/submissions/self and reads
       workflow_state, graded_at, posted_at, and score. A change in workflow_state
       (e.g. submitted -> graded) or graded_at also triggers a notification.

    3. Re-fetches the grades page HTML and parses #submission_520785: data-muted, and
       the score in .assignment_score .grade (an icon-off placeholder until posted,
       then the server-rendered number, e.g. 23.5, next to "/ 25").

    4. Calls /api/v1/courses/142383/enrollments?user_id=self and reads
       grades.current_score, which is the course Total shown on the page (99.08%).
       (The Total in the raw page HTML is only a placeholder; Canvas fills it in with JS.)

  Note: browsers throttle timers in background tabs (Chrome drops to roughly once a
  minute after ~5 min hidden). Keep the tab in its own window, or pin it and glance
  at it, if you need the full 15 s cadence. The change will still be caught, just
  up to a minute later.

  Any change to graded / posted score / Total fires a desktop notification, a sound,
  and a flashing tab title. The last-seen state is stored with GM_setValue so a page
  reload does not re-notify you for something you already know about.

  Click the small badge in the bottom-right corner to poll immediately, or to grant
  browser notification permission the first time.
*/

(function () {
  'use strict';

  // ---------- Config ----------
  const COURSE_ID = 142383;
  const ASSIGNMENT_ID = 520785;
  const ASSIGNMENT_NAME = 'Team Project';
  const POINTS_POSSIBLE = 25;
  const DUE_DATE = '2026-08-28T05:00:00Z'; // used to build a narrow planner window
  const POLL_SECONDS = 15;
  const STORAGE_KEY = `gradeWatcher:${COURSE_ID}:${ASSIGNMENT_ID}`;

  const GRADES_URL = `/courses/${COURSE_ID}/grades`;
  const SUBMISSION_URL = `/api/v1/courses/${COURSE_ID}/assignments/${ASSIGNMENT_ID}/submissions/self`;
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
    const start = isoDaysFrom(DUE_DATE, -7);
    const end = isoDaysFrom(DUE_DATE, +7);
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
      const sub = await fetchJson(SUBMISSION_URL);
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

  // ---------- Diff + main poll ----------
  function describe(s) {
    const sc = s.score != null ? `${s.score}/${POINTS_POSSIBLE}` : (s.muted ? 'hidden' : 'none');
    return `graded=${s.graded} needsGrading=${s.needsGrading} score=${sc} total=${s.total} muted=${s.muted}`;
  }

  async function poll(manual = false) {
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
    saveState(now);
    setBadge(
      `${ASSIGNMENT_NAME}: ${now.graded ? 'GRADED' : 'not graded'} · ` +
      `${now.score != null ? now.score + '/' + POINTS_POSSIBLE : 'hidden'} · Total ${now.total ?? '?'} · ` +
      `${new Date().toLocaleTimeString()}`,
      now.score != null ? '#2a2' : now.graded ? '#e80' : '#38c'
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
      badge.title = `Click to check now (auto every ${POLL_SECONDS} s)`;
      badge.addEventListener('click', () => {
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        poll(true);
      });
      document.body.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.background = colour;
  }

  // ---------- Start ----------
  if ('Notification' in window && Notification.permission === 'default') {
    // Permission requests need a user gesture; the badge click handles it.
    log('Click the badge once to allow browser notifications (GM_notification works without it).');
  }
  poll();
  setInterval(poll, POLL_SECONDS * 1000);
})();

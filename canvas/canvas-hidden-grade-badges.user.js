// ==UserScript==
// @name         Canvas - Hidden Grade Badges
// @namespace    https://github.com/Silverarmor/Userscripts
// @version      1.0.0
// @description  On a course grades page, shows a "Graded" / "Not graded" badge on every assignment whose grade is still hidden, using the same planner/submission APIs as assignment-status.js. Runs once per page load.
// @author       Silverarmor
// @match        https://canvas.auckland.ac.nz/courses/*/grades*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-hidden-grade-badges.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-hidden-grade-badges.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
  WHAT IT DOES
  ------------
  Canvas knows an assignment has been marked before the grades are released:
  the marker has entered a grade but it is still hidden from students
  ("Instructor has not posted this grade", the crossed-out eye icon).
  Excigma's assignment-status.js exposes this by dumping the planner API to
  the console; this script instead shows it inline on the grades page.

  On page (re)load, once, for every assignment row WITHOUT a visible score
  (hidden / not yet posted — a visible score already implies "graded", so
  those rows are left alone):

    - "Graded"      (orange) — marked in Canvas, waiting on release
    - "Not graded"  (grey)   — not marked yet ("In marking queue" if Canvas
                               reports it is sitting with the marker)

  placed in the title cell, on its own line under the assignment name and
  category (same spot Canvas puts its own context text). Hover a badge for
  details (graded_at timestamp, feedback flag). No polling — reload the page
  to refresh. For live notifications use canvas-grade-watcher.user.js.

  DATA SOURCES (both fetched in parallel, merged per assignment)
  ------------
  1. /api/v1/planner/items scoped to this course (same endpoint as
     assignment-status.js): submissions.graded flips to true as soon as a
     grade is entered, even while hidden. Only covers items with a date in
     the requested window, so undated assignments can be missing.
  2. /api/v1/courses/<id>/assignments?include[]=submission: covers every
     assignment; the submission's workflow_state / graded_at also reflect
     grading while the score itself is hidden.

  An assignment counts as graded if either source says so.
*/

(function () {
  'use strict';

  // Planner items only exist inside the requested date window; span most of
  // a year around today so a whole semester (and late releases) is covered.
  const PLANNER_DAYS_BACK = 240;
  const PLANNER_DAYS_AHEAD = 120;
  const MAX_PAGES = 10; // pagination safety cap per endpoint

  const COURSE_ID = Number((location.pathname.match(/\/courses\/(\d+)/) || [])[1]);
  if (!COURSE_ID) return;

  const log = (...a) => console.log('[HiddenGradeBadges]', ...a);

  // ---------- Fetch helpers ----------
  // Canvas prefixes JSON with "while(1);" on some endpoints, and paginates
  // via the Link: rel="next" response header.
  async function fetchJsonPaginated(firstUrl) {
    const out = [];
    let url = firstUrl;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      const text = await res.text();
      const data = JSON.parse(text.replace(/^while\(1\);/, ''));
      out.push(...(Array.isArray(data) ? data : [data]));
      const link = res.headers.get('Link') || '';
      url = (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null;
    }
    return out;
  }

  function isoDaysFromNow(days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  }

  // ---------- Source 1: planner API (graded flag, works while hidden) ----------
  async function fetchPlannerStatuses() {
    const items = await fetchJsonPaginated(
      `/api/v1/planner/items?start_date=${isoDaysFromNow(-PLANNER_DAYS_BACK)}` +
      `&end_date=${isoDaysFromNow(PLANNER_DAYS_AHEAD)}` +
      `&context_codes[]=course_${COURSE_ID}&per_page=100`
    );
    const byAssignment = new Map();
    for (const item of items) {
      const s = item.submissions;
      if (!s) continue;
      // Quizzes/discussions appear with their own plannable_id; their
      // plannable object carries the assignment id the grades page uses.
      const assignmentId =
        item.plannable_type === 'assignment' ? item.plannable_id
        : item.plannable?.assignment_id ?? null;
      if (assignmentId == null) continue;
      byAssignment.set(Number(assignmentId), {
        graded: !!s.graded,
        needsGrading: !!s.needs_grading,
        hasFeedback: !!s.has_feedback,
      });
    }
    return byAssignment;
  }

  // ---------- Source 2: assignments API with own submission included ----------
  async function fetchSubmissionStatuses() {
    const assignments = await fetchJsonPaginated(
      `/api/v1/courses/${COURSE_ID}/assignments?include[]=submission&per_page=100`
    );
    const byAssignment = new Map();
    for (const a of assignments) {
      const sub = a.submission;
      if (!sub) continue;
      byAssignment.set(Number(a.id), {
        graded: sub.workflow_state === 'graded' || sub.graded_at != null,
        gradedAt: sub.graded_at ?? null,
        excused: !!sub.excused,
      });
    }
    return byAssignment;
  }

  // ---------- Grades page rows whose score is hidden ----------
  // Real assignments are tr#submission_<numeric id>; group/total rows have
  // non-numeric suffixes. A hidden grade renders the crossed-out eye
  // (.icon-off) instead of a number; a visible number means "graded" is
  // already implied, so that row gets no badge.
  function hiddenRows() {
    const rows = [];
    for (const row of document.querySelectorAll('tr[id^="submission_"]')) {
      const m = row.id.match(/^submission_(\d+)$/);
      if (!m) continue;
      const gradeEl = row.querySelector('.assignment_score .grade');
      if (!gradeEl) continue;
      const clone = gradeEl.cloneNode(true);
      clone.querySelectorAll('.tooltip_wrap, .screenreader-only').forEach(n => n.remove());
      const scoreText = clone.textContent.replace(/\s+/g, ' ').trim();
      const hasVisibleScore =
        !gradeEl.querySelector('.icon-off') && Number.isFinite(parseFloat(scoreText.replace(',', '.')));
      if (hasVisibleScore) continue;
      if (/^EX$/i.test(scoreText)) continue; // excused — nothing to grade
      rows.push({ id: Number(m[1]), row, muted: row.getAttribute('data-muted') === 'true' });
    }
    return rows;
  }

  // ---------- Badge ----------
  function addBadge(row, { text, colour, title }) {
    const badge = document.createElement('span');
    badge.className = 'hidden-grade-badge';
    badge.textContent = text;
    badge.title = title;
    Object.assign(badge.style, {
      display: 'inline-block', padding: '1px 8px', borderRadius: '10px',
      fontSize: '11px', fontWeight: '700', lineHeight: '16px', color: '#fff',
      background: colour, whiteSpace: 'nowrap', cursor: 'help',
    });
    // Third line of the title cell, under the name link and the .context
    // category line; fall back to the score cell just in case.
    const cell = row.querySelector('th.title') || row.querySelector('td.assignment_score');
    if (!cell) return;
    const line = document.createElement('div');
    line.style.marginTop = '2px';
    line.appendChild(badge);
    cell.appendChild(line);
  }

  // ---------- Main (runs once per page load) ----------
  async function run() {
    const rows = hiddenRows();
    if (!rows.length) { log('No hidden-grade rows on this page — nothing to do.'); return; }

    const [planner, subs] = await Promise.all([
      fetchPlannerStatuses().catch(e => { log('Planner API failed:', e.message); return null; }),
      fetchSubmissionStatuses().catch(e => { log('Assignments API failed:', e.message); return null; }),
    ]);
    if (!planner && !subs) { log('Both APIs failed — no badges added.'); return; }

    for (const { id, row, muted } of rows) {
      const p = planner?.get(id);
      const s = subs?.get(id);
      if (!p && !s) { log(`Assignment ${id}: not found in either API, skipped.`); continue; }
      if (s?.excused) continue;

      const graded = !!(p?.graded || s?.graded);
      if (graded) {
        addBadge(row, {
          text: 'Graded',
          colour: '#e87b00',
          title:
            'Marked in Canvas but the grade has not been released to students yet.' +
            (s?.gradedAt ? `\nGraded at: ${new Date(s.gradedAt).toLocaleString()}` : '') +
            (p?.hasFeedback ? '\nFeedback has been left.' : ''),
        });
      } else {
        addBadge(row, {
          text: p?.needsGrading ? 'In marking queue' : 'Not graded',
          colour: '#888',
          title: p?.needsGrading
            ? 'Submitted and waiting to be marked.'
            : 'No grade has been entered in Canvas yet.',
        });
      }
      log(`Assignment ${id}: graded=${graded}`, { planner: p ?? 'n/a', submission: s ?? 'n/a', muted });
    }
    log(`Done — checked ${rows.length} hidden-grade row(s).`);
  }

  run().catch(e => log('Failed:', e));
})();

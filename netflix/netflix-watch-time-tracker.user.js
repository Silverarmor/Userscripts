// ==UserScript==
// @name         Netflix - Watch Time Tracker
// @namespace    https://github.com/Silverarmor/Userscripts
// @version      1.0.0
// @description  Tracks real (wall-clock) time spent watching Netflix with a daily and per-title stats panel. Unaffected by playback speed changes.
// @author       Silverarmor
// @match        https://www.netflix.com/*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/netflix/netflix-watch-time-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/netflix/netflix-watch-time-tracker.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // Time is accumulated as wall-clock seconds while the player is actually
  // playing, NOT as video.currentTime deltas, so changing playback speed
  // never inflates or deflates the totals.

  const STORAGE_KEY = "netflix-watch-time-tracker";
  const TICK_MS = 1000;
  const SAVE_EVERY_MS = 10000;
  // Ticks stop firing while the machine sleeps; cap the credit for a single
  // tick so a wake-up after hours asleep doesn't count as watch time.
  const MAX_TICK_CREDIT_S = 5;
  const UNKNOWN_TITLE = "Unknown title";
  const TITLE_SELECTOR = '[data-uia="video-title"]';
  const HISTORY_DAYS = 7;

  let data = loadData();
  let sessionSeconds = 0;
  let lastTickAt = Date.now();
  let lastSaveAt = Date.now();
  let dirty = false;

  // The title element only exists in the DOM while the player controls are
  // visible, so seconds are buffered per watch-page path until it appears.
  let currentPath = "";
  let currentTitle = "";
  let pendingSeconds = 0;

  let pillEl = null;
  let panelEl = null;
  let panelOpen = false;

  function loadData() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (parsed && typeof parsed === "object" && parsed.days && typeof parsed.days === "object") {
        return parsed;
      }
    } catch (error) {
      // Corrupt or missing data; start fresh below.
    }
    return { days: {} };
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      dirty = false;
      lastSaveAt = Date.now();
    } catch (error) {
      // Storage full or unavailable; totals stay in memory and retry later.
    }
  }

  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function dayBucket(key) {
    if (!data.days[key]) {
      data.days[key] = { seconds: 0, titles: {} };
    }
    return data.days[key];
  }

  function lastDayKeys(count) {
    const keys = [];
    const now = new Date();
    for (let i = 0; i < count; i++) {
      keys.push(dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    }
    return keys;
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.round(totalSeconds);
    if (seconds < 60) {
      return seconds === 0 ? "0m" : "<1m";
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  function isWatchPage() {
    return location.pathname.startsWith("/watch");
  }

  function findActiveVideo() {
    // Only count the actual player page; browse pages autoplay muted trailers
    // in <video> elements that shouldn't count as watch time.
    if (!isWatchPage()) {
      return null;
    }
    const video = document.querySelector("video");
    if (!video || video.paused || video.ended || video.readyState < 3) {
      return null;
    }
    return video;
  }

  function readTitle() {
    const el = document.querySelector(TITLE_SELECTOR);
    if (!el) {
      return "";
    }
    // Structure: <h4>Show name</h4><span>E7</span><span>Episode name</span>
    const parts = [];
    const heading = el.querySelector("h4");
    if (heading && heading.textContent.trim()) {
      parts.push(heading.textContent.trim());
    }
    const episodeBits = Array.from(el.querySelectorAll("span"))
      .map((span) => span.textContent.trim())
      .filter(Boolean);
    if (episodeBits.length > 0) {
      parts.push(episodeBits.join(" "));
    }
    return parts.join(" — ");
  }

  function addTitleSeconds(title, seconds) {
    if (seconds <= 0) {
      return;
    }
    const bucket = dayBucket(dateKey(new Date()));
    bucket.titles[title] = (bucket.titles[title] || 0) + seconds;
  }

  function flushPending(title) {
    if (pendingSeconds > 0) {
      addTitleSeconds(title, pendingSeconds);
      pendingSeconds = 0;
    }
  }

  function trackTitle() {
    if (!isWatchPage()) {
      if (currentPath) {
        flushPending(currentTitle || UNKNOWN_TITLE);
        currentPath = "";
        currentTitle = "";
      }
      return;
    }
    if (location.pathname !== currentPath) {
      // Episode changed (auto-advance or manual); close out the old one.
      flushPending(currentTitle || UNKNOWN_TITLE);
      currentPath = location.pathname;
      currentTitle = "";
    }
    if (!currentTitle) {
      const title = readTitle();
      if (title) {
        currentTitle = title;
        flushPending(title);
      }
    }
  }

  function tick() {
    const now = Date.now();
    const elapsed = Math.min((now - lastTickAt) / 1000, MAX_TICK_CREDIT_S);
    lastTickAt = now;

    trackTitle();

    if (findActiveVideo()) {
      sessionSeconds += elapsed;
      dayBucket(dateKey(new Date())).seconds += elapsed;
      if (currentTitle) {
        addTitleSeconds(currentTitle, elapsed);
      } else {
        pendingSeconds += elapsed;
      }
      dirty = true;
    }

    if (dirty && now - lastSaveAt >= SAVE_EVERY_MS) {
      saveData();
    }

    updateUi();
  }

  // ---------------------------------------------------------------- UI ----

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #nwt-pill {
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 9999999;
        background: rgba(20, 20, 20, 0.85);
        color: #e5e5e5;
        font: 12px/1.4 "Netflix Sans", "Helvetica Neue", Arial, sans-serif;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        cursor: pointer;
        opacity: 0.45;
        transition: opacity 0.15s ease;
        user-select: none;
      }
      #nwt-pill:hover, #nwt-pill.nwt-open {
        opacity: 1;
      }
      #nwt-panel {
        position: fixed;
        right: 14px;
        bottom: 48px;
        z-index: 9999999;
        width: 260px;
        background: rgba(20, 20, 20, 0.97);
        color: #e5e5e5;
        font: 12px/1.5 "Netflix Sans", "Helvetica Neue", Arial, sans-serif;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.6);
      }
      #nwt-panel h3 {
        margin: 0 0 8px;
        font-size: 13px;
        color: #fff;
      }
      #nwt-panel .nwt-row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      #nwt-panel .nwt-row span:first-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #nwt-panel .nwt-section {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
      }
      #nwt-panel .nwt-muted {
        color: #999;
      }
      #nwt-panel .nwt-buttons {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      #nwt-panel button {
        flex: 1;
        background: #333;
        color: #e5e5e5;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        padding: 4px 6px;
        font: inherit;
        cursor: pointer;
      }
      #nwt-panel button:hover {
        background: #444;
      }
    `;
    document.head.appendChild(style);
  }

  function buildUi() {
    pillEl = document.createElement("div");
    pillEl.id = "nwt-pill";
    pillEl.title = "Netflix Watch Time Tracker";
    pillEl.addEventListener("click", () => {
      panelOpen = !panelOpen;
      pillEl.classList.toggle("nwt-open", panelOpen);
      panelEl.style.display = panelOpen ? "block" : "none";
      if (panelOpen) {
        renderPanel();
      }
    });

    panelEl = document.createElement("div");
    panelEl.id = "nwt-panel";
    panelEl.style.display = "none";

    document.body.appendChild(pillEl);
    document.body.appendChild(panelEl);
  }

  function updateUi() {
    if (!pillEl) {
      return;
    }
    // Netflix's SPA can rebuild <body> contents; re-attach if detached.
    if (!pillEl.isConnected) {
      document.body.appendChild(pillEl);
      document.body.appendChild(panelEl);
    }
    const today = dayBucket(dateKey(new Date())).seconds;
    pillEl.textContent = `⏱ ${formatDuration(today)} today`;
    if (panelOpen) {
      renderPanel();
    }
  }

  function renderPanel() {
    const keys = lastDayKeys(HISTORY_DAYS);
    const todayTotal = (data.days[keys[0]] || { seconds: 0 }).seconds;
    let weekTotal = 0;
    const titleTotals = {};
    for (const key of keys) {
      const day = data.days[key];
      if (!day) {
        continue;
      }
      weekTotal += day.seconds;
      for (const [title, seconds] of Object.entries(day.titles)) {
        titleTotals[title] = (titleTotals[title] || 0) + seconds;
      }
    }
    const allTimeTotal = Object.values(data.days).reduce((sum, day) => sum + day.seconds, 0);
    const topTitles = Object.entries(titleTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    panelEl.textContent = "";

    const heading = document.createElement("h3");
    heading.textContent = "Netflix watch time";
    panelEl.appendChild(heading);

    appendRow(panelEl, "This session", formatDuration(sessionSeconds));
    appendRow(panelEl, "Today", formatDuration(todayTotal));
    appendRow(panelEl, `Last ${HISTORY_DAYS} days`, formatDuration(weekTotal));
    appendRow(panelEl, "All time", formatDuration(allTimeTotal));

    const daysSection = document.createElement("div");
    daysSection.className = "nwt-section";
    for (const key of keys) {
      const seconds = (data.days[key] || { seconds: 0 }).seconds;
      appendRow(daysSection, key, formatDuration(seconds), seconds === 0);
    }
    panelEl.appendChild(daysSection);

    if (topTitles.length > 0) {
      const titlesSection = document.createElement("div");
      titlesSection.className = "nwt-section";
      for (const [title, seconds] of topTitles) {
        appendRow(titlesSection, title, formatDuration(seconds));
      }
      panelEl.appendChild(titlesSection);
    }

    const buttons = document.createElement("div");
    buttons.className = "nwt-buttons";

    const exportButton = document.createElement("button");
    exportButton.textContent = "Export JSON";
    exportButton.addEventListener("click", exportData);
    buttons.appendChild(exportButton);

    const resetButton = document.createElement("button");
    resetButton.textContent = "Reset";
    resetButton.addEventListener("click", resetData);
    buttons.appendChild(resetButton);

    panelEl.appendChild(buttons);
  }

  function appendRow(parent, label, value, muted) {
    const row = document.createElement("div");
    row.className = "nwt-row" + (muted ? " nwt-muted" : "");
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    labelEl.title = label;
    const valueEl = document.createElement("span");
    valueEl.textContent = value;
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    parent.appendChild(row);
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `netflix-watch-time-${dateKey(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function resetData() {
    if (!window.confirm("Reset all Netflix watch time data? This cannot be undone.")) {
      return;
    }
    data = { days: {} };
    sessionSeconds = 0;
    pendingSeconds = 0;
    saveData();
    renderPanel();
  }

  // -------------------------------------------------------------- start ----

  function start() {
    injectStyles();
    buildUi();
    updateUi();
    setInterval(tick, TICK_MS);

    const flushAndSave = () => {
      flushPending(currentTitle || UNKNOWN_TITLE);
      if (dirty) {
        saveData();
      }
    };
    window.addEventListener("pagehide", flushAndSave);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushAndSave();
      }
    });
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
})();

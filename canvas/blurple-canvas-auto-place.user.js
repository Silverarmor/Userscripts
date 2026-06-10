// ==UserScript==
// @name         Blurple Canvas - Auto Place Ready Pixel
// @namespace    https://github.com/Silverarmor/Userscripts
// @version      0.1.1
// @description  Clicks the visible Place pixel button when cooldown ends, but only when a pixel is selected.
// @author       Silverarmor
// @match        https://canvas.projectblurple.com/*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/blurple-canvas-auto-place.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/blurple-canvas-auto-place.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CHECK_INTERVAL_MS = 750;
  const CLICK_DEBOUNCE_MS = 3000;
  const DEFAULT_COOLDOWN_MS = 15000;
  const MIN_RANDOM_DELAY_MS = 500;
  const MAX_RANDOM_DELAY_MS = 3000;
  const TOGGLE_ID = "blurple-auto-place-toggle";
  let cooldownSeen = false;
  let enabled = true;
  let lastClickAt = 0;
  let nextAllowedClickAt = 0;
  let pendingClickId = 0;
  let pendingClickTimer = null;

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function isDisabled(button) {
    return (
      button.disabled ||
      button.getAttribute("aria-disabled") === "true" ||
      button.classList.contains("Mui-disabled")
    );
  }

  function getPlaceButton() {
    return Array.from(document.querySelectorAll("button[type='submit']"))
      .filter(isVisible)
      .find((button) => /^Place\b/i.test(normalizeText(button.textContent || "")));
  }

  function hasSelectedPixel(button) {
    return /\(\s*\d+\s*,\s*\d+\s*\)/.test(normalizeText(button.textContent || ""));
  }

  function getCooldownMs() {
    const pageText = document.documentElement.textContent || "";
    const match = pageText.match(/"cooldownDuration"\s*:\s*(\d+)/);
    const seconds = match ? Number(match[1]) : 0;

    return seconds > 0 ? seconds * 1000 : DEFAULT_COOLDOWN_MS;
  }

  function clearPendingClick() {
    pendingClickId += 1;

    if (pendingClickTimer !== null) {
      window.clearTimeout(pendingClickTimer);
      pendingClickTimer = null;
    }
  }

  function updateToggleButton(button) {
    button.textContent = enabled ? "Auto place: on" : "Auto place: off";
    button.setAttribute("aria-pressed", String(enabled));
    button.style.background = enabled ? "#5865f2" : "#4f545c";
  }

  function addToggleButton() {
    if (document.getElementById(TOGGLE_ID)) {
      return;
    }

    const button = document.createElement("button");
    button.id = TOGGLE_ID;
    button.type = "button";
    button.style.position = "fixed";
    button.style.left = "12px";
    button.style.bottom = "12px";
    button.style.zIndex = "2147483647";
    button.style.border = "0";
    button.style.borderRadius = "6px";
    button.style.color = "#fff";
    button.style.cursor = "pointer";
    button.style.font = "600 12px system-ui, sans-serif";
    button.style.padding = "8px 10px";
    button.style.boxShadow = "0 2px 8px rgb(0 0 0 / 35%)";
    button.addEventListener("click", () => {
      enabled = !enabled;

      if (!enabled) {
        clearPendingClick();
      }

      updateToggleButton(button);
      maybePlacePixel();
    });

    document.body.appendChild(button);
    updateToggleButton(button);
  }

  function scheduleClick(button) {
    const clickId = ++pendingClickId;
    const delay = Math.floor(MIN_RANDOM_DELAY_MS + Math.random() * (MAX_RANDOM_DELAY_MS - MIN_RANDOM_DELAY_MS + 1));

    pendingClickTimer = window.setTimeout(() => {
      pendingClickTimer = null;

      if (clickId !== pendingClickId || !button.isConnected || !isVisible(button)) {
        return;
      }

      if (!enabled) {
        return;
      }

      if (
        !hasSelectedPixel(button) ||
        isDisabled(button) ||
        /on cooldown|cooldown/i.test(normalizeText(button.textContent || ""))
      ) {
        return;
      }

      lastClickAt = Date.now();
      nextAllowedClickAt = lastClickAt + getCooldownMs();
      cooldownSeen = false;
      button.click();
    }, delay);
  }

  function maybePlacePixel() {
    if (!enabled) {
      return;
    }

    const button = getPlaceButton();

    if (!button || !hasSelectedPixel(button)) {
      cooldownSeen = false;
      clearPendingClick();
      return;
    }

    const buttonText = normalizeText(button.textContent || "");
    if (/on cooldown|cooldown/i.test(buttonText) || isDisabled(button)) {
      cooldownSeen = true;
      clearPendingClick();
      return;
    }

    const now = Date.now();
    if (pendingClickTimer !== null || now < nextAllowedClickAt || now - lastClickAt < CLICK_DEBOUNCE_MS) {
      return;
    }

    if (cooldownSeen || lastClickAt === 0 || now >= nextAllowedClickAt) {
      scheduleClick(button);
    }
  }

  function start() {
    addToggleButton();
    maybePlacePixel();
    window.setInterval(maybePlacePixel, CHECK_INTERVAL_MS);

    const observer = new MutationObserver(maybePlacePixel);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
  document.addEventListener("visibilitychange", (e) => {
  e.stopImmediatePropagation();
}, true); // The 'true' uses the capturing phase to catch it first
})();

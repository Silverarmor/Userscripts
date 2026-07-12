// ==UserScript==
// @name         Gmail - Promotions Sponsored Cleanup
// @namespace    https://github.com/Silverarmor/Userscripts
// @version      1.0.0
// @description  Removes Gmail sponsored ad rows from the message list without hiding real emails that mention "Sponsored".
// @author       Silverarmor
// @match        https://mail.google.com/mail/u/0/*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/gmail/gmail-promotions-sponsored-cleanup.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/gmail/gmail-promotions-sponsored-cleanup.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const ROW_SELECTOR = 'tr[role="row"].zA';
  const HIDDEN_SUMMARY_SELECTOR = ".afn";
  const AD_BADGE_SELECTOR = ".ast";
  const SPONSORED_LABEL_SELECTOR = ".bGY.FFM8Yd";
  const SCAN_DEBOUNCE_MS = 100;

  let scanTimer = 0;

  function hasExactText(element, text) {
    return element && element.textContent.trim() === text;
  }

  function hasGmailSponsoredSummary(row) {
    return Array.from(row.querySelectorAll(HIDDEN_SUMMARY_SELECTOR)).some((summary) => {
      return summary.textContent.trim().startsWith("Sponsored, open in new window");
    });
  }

  function hasVisibleAdMarkers(row) {
    const hasAdBadge = Array.from(row.querySelectorAll(AD_BADGE_SELECTOR)).some((badge) => {
      return hasExactText(badge, "Ad");
    });

    const hasSponsoredLabel = Array.from(row.querySelectorAll(SPONSORED_LABEL_SELECTOR)).some((label) => {
      return label.childNodes.length > 0 && label.childNodes[0].textContent.trim() === "Sponsored";
    });

    return hasAdBadge && hasSponsoredLabel;
  }

  function isSponsoredAdRow(row) {
    if (!row.matches(ROW_SELECTOR)) {
      return false;
    }

    return hasGmailSponsoredSummary(row) && hasVisibleAdMarkers(row);
  }

  function removeSponsoredRows(root = document) {
    root.querySelectorAll(ROW_SELECTOR).forEach((row) => {
      if (isSponsoredAdRow(row)) {
        row.remove();
      }
    });
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => removeSponsoredRows(), SCAN_DEBOUNCE_MS);
  }

  function startObserver() {
    removeSponsoredRows();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) {
            continue;
          }

          if (node.matches(ROW_SELECTOR) && isSponsoredAdRow(node)) {
            node.remove();
            continue;
          }

          if (node.querySelector(ROW_SELECTOR)) {
            scheduleScan();
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.body) {
    startObserver();
  } else {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }
})();

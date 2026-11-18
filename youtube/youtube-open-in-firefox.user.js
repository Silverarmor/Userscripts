// ==UserScript==
// @name         YouTube - Open Links in Firefox
// @namespace    https://github.com/Silverarmor/Userscripts
// @version      1.1.0
// @description  Opens clicked YouTube links in Firefox instead of Chrome, via the openinff: protocol handler (see youtube/openinff.reg). Shift+click opens the link normally.
// @author       Silverarmor
// @match        *://*/*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/youtube/youtube-open-in-firefox.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/youtube/youtube-open-in-firefox.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const PROTOCOL = "openinff:";
  const YOUTUBE_LINK =
    /^https?:\/\/((www\.|m\.|music\.)?youtube\.com\/(watch|shorts|live|playlist)|youtu\.be\/)/i;

  function asYouTube(value) {
    if (!value) return null;
    let url = value.trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    return YOUTUBE_LINK.test(url) && !/\s|…/.test(url) ? url : null;
  }

  // Many sites (Gmail, Google search, X, Facebook, Reddit, YouTube descriptions)
  // wrap links in a redirect URL, so also look in its query parameters and,
  // failing that, the link text (e.g. X shows "youtu.be/..." over a t.co link).
  function youtubeUrlFor(link) {
    const direct = asYouTube(link.href);
    if (direct) return direct;

    try {
      for (const value of new URL(link.href).searchParams.values()) {
        const wrapped = asYouTube(value);
        if (wrapped) return wrapped;
      }
    } catch (_) {
      // Not a parseable URL; fall through to the link text.
    }

    return asYouTube(link.textContent);
  }

  function findLink(event) {
    // composedPath() also finds links inside shadow DOM.
    for (const node of event.composedPath()) {
      if (node instanceof HTMLAnchorElement && node.href) return node;
    }
    return null;
  }

  function handleClick(event) {
    if (event.defaultPrevented || event.shiftKey) return;
    // Left click or middle click only.
    if (event.type === "click" && event.button !== 0) return;
    if (event.type === "auxclick" && event.button !== 1) return;

    const link = findLink(event);
    const url = link && youtubeUrlFor(link);
    if (!url) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.href = PROTOCOL + url;
  }

  document.addEventListener("click", handleClick, true);
  document.addEventListener("auxclick", handleClick, true);
})();

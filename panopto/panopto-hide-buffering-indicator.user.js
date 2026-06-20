// ==UserScript==
// @name         Panopto - Hide buffering indicator
// @namespace    https://github.com/Silverarmor
// @version      1.0.1
// @description  Hides Panopto's transient centre-screen loading indicator without changing video playback.
// @author       Silverarmor
// @match        https://auckland.au.panopto.com/Panopto/Pages/Viewer.aspx*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/panopto/panopto-hide-buffering-indicator.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/panopto/panopto-hide-buffering-indicator.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";

    // Panopto toggles this outer overlay's visibility as buffering begins and ends.
    const loaderSelector = ".bufferingIndicator";

    const style = document.createElement("style");
    style.textContent = `${loaderSelector} {
        display: none !important;
        pointer-events: none !important;
    }`;

    function injectStyle() {
        (document.head || document.documentElement).append(style);
    }

    if (document.head || document.documentElement) injectStyle();
    else document.addEventListener("DOMContentLoaded", injectStyle, { once: true });
})();

// ==UserScript==
// @name         Panopto - Clean player
// @namespace    https://github.com/Silverarmor
// @version      1.3.0
// @description  Hides Panopto's transient buffering indicator, player branding, and transcript notice, and keeps speed controls visible.
// @author       Silverarmor
// @match        https://auckland.au.panopto.com/Panopto/Pages/Viewer.aspx*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/panopto/panopto-clean-player.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/panopto/panopto-clean-player.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";

    // The buffering overlay exists once per stream; the other selectors cover
    // the in-player logo, branding footer, and transcript notice.
    const hiddenSelector = [
        ".bufferingIndicator",
        ".logo-container-while-playing",
        ".cobrand",
        ".warning-overlay-container"
    ].join(", ");

    const style = document.createElement("style");
    style.textContent = `${hiddenSelector} {
        display: none !important;
        pointer-events: none !important;
    }

    #PlayBackRatePanelYPSC {
        display: inline !important;
    }`;

    function injectStyle() {
        (document.head || document.documentElement).append(style);
    }

    if (document.head || document.documentElement) injectStyle();
    else document.addEventListener("DOMContentLoaded", injectStyle, { once: true });
})();

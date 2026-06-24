// ==UserScript==
// @name         111 Emergency - Page Cleanup
// @namespace    https://github.com/Silverarmor/Userscripts
// @version      1.1.0
// @description  Cleans up 111 Emergency pages by improving background readability and hiding the footer banner.
// @author       Silverarmor
// @match        https://*.111emergency.co.nz/*
// @match        https://111emergency.co.nz/*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/111emergency/111emergency-page-cleanup.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/111emergency/111emergency-page-cleanup.user.js
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  GM_addStyle(`
    body {
      background-color: #d1d5db !important;
      background-image: none !important;
    }

    img[src$="111emergencybanner.JPG" i] {
      display: none !important;
    }
  `);
})();

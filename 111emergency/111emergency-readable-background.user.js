// ==UserScript==
// @name         111 Emergency - Readable Background
// @namespace    https://github.com/Silverarmor/Userscripts
// @version      1.0.0
// @description  Replaces 111 Emergency's patterned page background with a high-contrast grey.
// @author       Silverarmor
// @match        https://*.111emergency.co.nz/*
// @match        https://111emergency.co.nz/*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/111emergency/111emergency-readable-background.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/111emergency/111emergency-readable-background.user.js
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
  `);
})();

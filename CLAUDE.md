# CLAUDE.md

Personal playground repo of browser userscripts and small utilities. Most files are Tampermonkey userscripts (`*.user.js`), plus a few PowerShell helpers (`*.ps1`) and a Node.js scraper (`uoa/`). Many scripts target University of Auckland services (Panopto, Canvas).

## Layout

- One directory per target site/service: `panopto/`, `canvas/`, `gmail/`, `netflix/`, `111emergency/`, `hellofresh/`, `explorer/`, `uoa/`.
- `README.md` lists every script with a raw-install link and one-line description. **When adding a script, add it to the matching README section.**

## Userscript conventions

Metadata block (see any existing script for reference):

- `@name` is `<Site> - <Function>` (e.g. `Gmail - Promotions Sponsored Cleanup`).
- `@version` is semver-ish and **must be bumped on every change** — Tampermonkey uses it for auto-updates.
- `@updateURL` / `@downloadURL` point at the raw GitHub URL on `master` matching the file's path. Renaming or moving a file breaks auto-update for existing installs; avoid it.
- `@match` patterns are deliberately narrow (often UoA-specific hosts). Note they are case-sensitive on the path.
- `@author Silverarmor`, `@namespace` and `@homepageURL` point at this repo.

Code style:

- Entire script wrapped in an IIFE with `"use strict"`.
- Indentation is per-file (some 2-space, some 4-space) — match the file you're editing.
- `UPPER_SNAKE` constants at the top; small named helper functions; section divider comments (`/* ----- Section ----- */`).
- Longer-running scripts log a boot message with the version, prefixed with a script tag, e.g. `console.log("[PanoptoCC] Script booting at v0.1.16")`.

Patterns:

- **Hide, don't delete**: prefer `display: none !important` (via `GM_addStyle` or `style.setProperty(..., 'important')`) over removing DOM nodes — sites can break when expected nodes disappear.
- SPA/dynamic pages: use a `MutationObserver` on `document.body` with idempotent init functions (guard with a class/dataset marker before injecting UI), or bounded polling (`MAX_SETUP_ATTEMPTS`).
- `@run-at document-start` for scripts that must beat page JS (network interception, early CSS); `document-idle` for UI-adding scripts.
- Scripts with `@grant none` run in the page world; scripts using `GM_*` run sandboxed — reach the page via `unsafeWindow`. Feature-detect GM functions (`typeof GM_addStyle === "function"`) with DOM fallbacks where practical.
- Site CSS class names that look like `css-<hash>` (Emotion/MUI, e.g. on Panopto) are build-generated and brittle — prefer stable ids like `#transcriptPaneHeader` when possible, and expect hash selectors to break on site redesigns.

## Panopto captions script — special caveats

`panopto/panopto_captions.user.js` intercepts the viewer's `fetch` to `DeliveryInfo.aspx` and substitutes stored SRT captions. Two hard-won constraints:

1. **Injection timing matters.** Interception only works if the script runs before the viewer requests captions. On Chrome MV3 this requires Tampermonkey's *Content Script API = UserScripts API Dynamic* (see README). The script self-heals a lost race by auto-reloading (bounded by a sessionStorage retry counter).
2. **GM storage lags in Dynamic mode.** GM values are injected as a snapshot that can be one reload stale after `GM_setValue`/`GM_deleteValue` (tampermonkey#2123). Writes are mirrored in `sessionStorage` (`writeCaptionStore`/`readCaptionStore`) so save/revert take effect on the first reload. Any new GM writes followed by a reload should go through those helpers.

## Workflow

- Default branch is `master`. Make changes on a feature branch and open a PR; don't commit to `master` directly.
- Commit messages: short imperative subject line, body explaining the why for non-trivial changes.
- No build step, linter, or test suite. Sanity-check syntax with `node --check <file>` and test manually in the browser (Tampermonkey on Chrome is the primary target; scripts should stay Violentmonkey/Greasemonkey-compatible where practical).

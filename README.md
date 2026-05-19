# Userscripts

⚠️ Vibe coding zone! Just my playground for random scripts. Not intended for use.

Intended for [Tampermonkey](https://www.tampermonkey.net/), but should also be compatible with [Violentmonkey](https://violentmonkey.github.io/get-it/) and [Greasemonkey](https://www.greasespot.net/).

## Installing a userscript manager

### Chrome

1. Install [Tampermonkey from the Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. Open `chrome://extensions`, select **Tampermonkey**, and make sure it is enabled.
3. If scripts do not run, Chrome may need one extra permission step for recent Tampermonkey versions:
   - In Chrome 138 or newer, open Tampermonkey's extension details and enable **Allow User Scripts**.
   - If that toggle is not available, enable **Developer mode** on `chrome://extensions`.

See Tampermonkey's FAQ entry on the Chrome `userScripts` requirement: [Q209](https://www.tampermonkey.net/faq.php?ext=dhdg&q=Q209).

### Safari alternatives

Safari users have a few options:

- [Tampermonkey for Safari](https://www.tampermonkey.net/index.php?browser=safari&locale=en) is available through the App Store.
- [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887) is a free, open-source Safari extension for macOS, iOS, and iPadOS. Source/help: [quoid/userscripts](https://github.com/quoid/userscripts).

After installing a Safari extension, enable it in Safari's extension settings and allow it to run on the sites where the script should work.

## Installing scripts from this repo

1. Click one of the `.user.js` links below.
2. If GitHub opens a source page instead of Tampermonkey, click **Raw**. A raw `.user.js` URL should open the install screen in your userscript manager.
3. Review the script permissions and click **Install**.
4. Refresh any matching site that was already open.

For example, this raw link should prompt Tampermonkey to install the Canvas helper: [canvas/canvas-quiz-copy-question.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-quiz-copy-question.user.js).

## Scripts

- [canvas/canvas-quiz-copy-question.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-quiz-copy-question.user.js): Adds copy buttons to University of Auckland Canvas quiz questions so the question text and answer options can be copied quickly.
- [panopto/panopto_captions.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/panopto/panopto_captions.user.js): Adds custom SRT caption upload/storage support to University of Auckland Panopto videos, plus refresh and direct media download controls.
  - [panopto/OrganiseTranscripts.ps1](panopto/OrganiseTranscripts.ps1): Organises downloaded Panopto transcript files into a cleaner folder structure and generates `.txt` files for ingestion as source material in other models.
  - [panopto/sort_transcripts.ps1](panopto/sort_transcripts.ps1): Archived/superseded helper for sorting downloaded Panopto transcript files.

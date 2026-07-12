# Userscripts and Small Utilities

⚠️ Vibe coding zone! Just my playground for random scripts. Not intended for use.

This repo is mostly browser userscripts, but not everything here is a Tampermonkey script. Files ending in `.user.js` are intended for [Tampermonkey](https://www.tampermonkey.net/), and should also be compatible with [Violentmonkey](https://violentmonkey.github.io/get-it/) and [Greasemonkey](https://www.greasespot.net/). Other scripts may be command-line utilities or helper scripts.

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

For example, this raw link should prompt Tampermonkey to install a Canvas helper: [canvas/canvas-quiz-copy-question.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-quiz-copy-question.user.js).

## Browser Userscripts

- [canvas/blurple-canvas-auto-place.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/blurple-canvas-auto-place.user.js): Automatically clicks the Project Blurple Canvas place button when the cooldown ends and a pixel is selected, with an on-page toggle.
- [canvas/canvas-quiz-copy-question.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/canvas/canvas-quiz-copy-question.user.js): Adds copy buttons to University of Auckland Canvas quiz questions so the question text and answer options can be copied quickly.
- [111emergency/111emergency-page-cleanup.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/111emergency/111emergency-page-cleanup.user.js): Cleans up 111 Emergency pages by improving background readability and hiding the footer banner.
- [panopto/panopto_captions.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/panopto/panopto_captions.user.js): Adds custom SRT caption upload/storage support to University of Auckland Panopto videos, plus refresh and direct media download controls.
- [panopto/panopto-clean-player.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/panopto/panopto-clean-player.user.js): Hides Panopto's transient buffering indicator and player branding without changing playback.
- [hellofresh/hellofresh_chat_enhancer.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/hellofresh/hellofresh_chat_enhancer.user.js): Adds a fullscreen mode and transcript download option to Hellofresh support.
- [gmail/gmail-promotions-sponsored-cleanup.user.js](https://raw.githubusercontent.com/Silverarmor/Userscripts/master/gmail/gmail-promotions-sponsored-cleanup.user.js): Removes Gmail sponsored ad rows from message lists while leaving real emails that mention "Sponsored" alone.

## Other Utilities

- [uoa/uoa-course-components.md](uoa/uoa-course-components.md): Node.js command-line scraper for the public University of Auckland course catalogue. It outputs class component mappings, such as `LEC` to `Lecture`, plus a course code/title CSV.

## Helper Scripts

- [explorer/organise-by-year.ps1](explorer/organise-by-year.ps1): Organises media, all files, or selected file extensions into date-based folders using filenames that begin with a selected date format, such as `YYYYMMDD` or `YYYY-MM-DD`, with progress indicators for large folders.
- [panopto/OrganiseTranscripts.ps1](panopto/OrganiseTranscripts.ps1): Organises downloaded Panopto transcript files into a cleaner folder structure and generates `.txt` files for ingestion as source material in other models.
- [panopto/sort_transcripts.ps1](panopto/sort_transcripts.ps1): Archived/superseded helper for sorting downloaded Panopto transcript files.

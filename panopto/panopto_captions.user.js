// ==UserScript==
// @name         Custom .srt captions - panopto.com
// @namespace    https://github.com/Silverarmor
// @version      0.1.7
// @description  Allows uploading custom SRT captions to Panopto with persistent per-video storage, custom SRT search, drag-and-drop support, clean page refreshing, and direct MP4 audio/video downloads.
// @author       Silverarmor
// @match        https://auckland.au.panopto.com/Panopto/Pages/Viewer.aspx*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/panopto/panopto_captions.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/panopto/panopto_captions.user.js
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";

    console.log("[PanoptoCC] Script booting at v0.1.7");

    let injectedCaptions = null;
    let isCustomSrtActive = false;
    let uploadTimestamp = null;
    let videoUUID = null;

    /* -----------------------------
       Helper: Refresh Page
    ----------------------------- */
    function refreshPage() {
        window.location.href = window.location.href;
    }

    /* -----------------------------
       Helper: Get Video UUID
    ----------------------------- */
    function getVideoId() {
        const params = new URLSearchParams(window.location.search);
        let id = params.get("id");
        if (!id) {
            const metaTag = document.querySelector('meta[property="og:url"]');
            if (metaTag) {
                try {
                    const urlObj = new URL(metaTag.getAttribute("content"));
                    id = urlObj.searchParams.get("id");
                } catch (e) { }
            }
        }
        return id;
    }

    /* -----------------------------
       Load captions from GM Storage
    ----------------------------- */
    videoUUID = getVideoId();

    if (videoUUID) {
        try {
            const storedData = GM_getValue(videoUUID, null);
            if (storedData) {
                const parsed = JSON.parse(storedData);
                if (parsed.captions) {
                    injectedCaptions = parsed.captions;
                    uploadTimestamp = parsed.timestamp;
                } else {
                    injectedCaptions = parsed;
                }
                isCustomSrtActive = true;
            }
        } catch (err) {
            console.error("[PanoptoCC] Storage load failed", err);
        }
    }

    /* -----------------------------
       Fetch Proxy
    ----------------------------- */
    const pageWindow = unsafeWindow || window;
    const originalFetch = pageWindow.fetch;

    pageWindow.fetch = new Proxy(originalFetch, {
        apply(target, thisArg, args) {
            const urlArg = args[0];
            const options = args[1] || {};
            let url = (typeof urlArg === "string") ? urlArg : (urlArg.url || urlArg.href || "");

            if (url.includes("DeliveryInfo.aspx")) {
                let bodyString = "";
                const body = options.body;
                if (typeof body === "string") bodyString = body;
                else if (body instanceof URLSearchParams) bodyString = body.toString();

                if (bodyString.includes("getCaptions=true") && injectedCaptions) {
                    return Promise.resolve(
                        new Response(JSON.stringify(injectedCaptions), {
                            status: 200,
                            headers: { "Content-Type": "application/json" }
                        })
                    );
                }
            }
            return Reflect.apply(target, thisArg, args);
        }
    });

    /* -----------------------------
       SRT Parser
    ----------------------------- */
    function srtTimeToSeconds(time) {
        const parts = time.split(":");
        const hours = parseInt(parts[0]);
        const minutes = parseInt(parts[1]);
        const secParts = parts[2].split(",");
        const seconds = parseInt(secParts[0]);
        const millis = parseInt(secParts[1] || 0);
        return hours * 3600 + minutes * 60 + seconds + millis / 1000;
    }

    function parseSRT(text) {
        const blocks = text.replace(/\r/g, "").trim().split(/\n\n+/);
        const captions = [];
        for (const block of blocks) {
            const lines = block.split("\n");
            if (lines.length < 2) continue;
            const match = lines[1].match(/(.+) --> (.+)/);
            if (!match) continue;
            const start = srtTimeToSeconds(match[1].trim());
            const end = srtTimeToSeconds(match[2].trim());
            captions.push({
                Caption: lines.slice(2).join(" ").trim(),
                CaptionDuration: end - start,
                Time: start,
                AbsoluteTime: 0, CreatedDuringWebcast: false, CreationDateTime: "\\/Date(-11644473600000)\\/",
                CreationTime: 0, Data: null, Duration: 0, EventTargetType: null, ID: 0, IsQuestionList: false,
                IsSessionPlaybackBlocking: false, ObjectIdentifier: null, ObjectPublicIdentifier: "00000000-0000-0000-0000-000000000000",
                ObjectSequenceNumber: null, ObjectStreamID: "00000000-0000-0000-0000-000000000000",
                PublicId: "00000000-0000-0000-0000-000000000000", SessionID: "00000000-0000-0000-0000-000000000000",
                ShowInTableOfContents: false, Url: null, UserDisplayName: null, UserInvocationRequiredInUrl: false, UserName: null
            });
        }
        return captions;
    }

    /* -----------------------------
       Custom SRT Search
    ----------------------------- */
    function normaliseSearchText(text) {
        return (text || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
    }

    function escapeHTML(text) {
        const div = document.createElement("div");
        div.textContent = text || "";
        return div.innerHTML;
    }

    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function captionStartTime(caption) {
        return Number(caption && (caption.Time ?? caption.StartTime ?? caption.Start)) || 0;
    }

    function highlightMatches(text, terms) {
        let escaped = escapeHTML(text || "");
        const uniqueTerms = Array.from(new Set(terms.filter(Boolean))).sort((a, b) => b.length - a.length);
        if (!uniqueTerms.length) return escaped;

        const pattern = uniqueTerms.map(escapeRegExp).join("|");
        return escaped.replace(new RegExp(`(${pattern})`, "gi"), "<span class=\"search-match\">$1</span>");
    }

    function getCustomSearchTerms(query) {
        const phrase = normaliseSearchText(query);
        const terms = phrase.split(" ").filter(Boolean);
        return phrase.length > 1 ? [phrase, ...terms] : terms;
    }

    function findCustomCaptionMatches(query) {
        const terms = getCustomSearchTerms(query);
        if (!terms.length || !Array.isArray(injectedCaptions)) return [];

        return injectedCaptions
            .map((caption, index) => ({ caption, index, searchable: normaliseSearchText(caption.Caption) }))
            .filter((item) => terms.every((term) => item.searchable.includes(term)))
            .sort((a, b) => captionStartTime(a.caption) - captionStartTime(b.caption));
    }

    function findTranscriptRowByTime(seconds) {
        const targetMillis = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
        return Array.from(document.querySelectorAll("#transcriptTabPane li[id^='UserCreatedTranscript-']"))
            .find((row) => {
                const match = row.id.match(/^UserCreatedTranscript-(\d+)/);
                return match && Math.abs(Number(match[1]) - targetMillis) <= 250;
            });
    }

    function selectTranscriptTab() {
        const transcriptTabHeader = document.querySelector("#transcriptTabHeader");
        const transcriptTabPane = document.querySelector("#transcriptTabPane");
        if (!transcriptTabHeader || !transcriptTabPane) return;

        document.querySelectorAll("#eventTabControl .event-tab-header").forEach((tab) => {
            tab.classList.remove("selected");
            tab.setAttribute("aria-selected", "false");
            tab.setAttribute("tabindex", "-1");
        });

        document.querySelectorAll("#eventTabPanes .event-tab-pane").forEach((pane) => {
            pane.style.display = "none";
        });

        transcriptTabHeader.style.display = "";
        transcriptTabHeader.classList.add("selected");
        transcriptTabHeader.setAttribute("aria-selected", "true");
        transcriptTabHeader.setAttribute("tabindex", "0");
        transcriptTabPane.style.display = "";
    }

    function clearCaptionSearchHighlights() {
        document.querySelectorAll("#transcriptTabPane .custom-srt-caption-search-match").forEach((row) => {
            const textSpan = row.querySelector(".event-text span");
            if (textSpan && textSpan.dataset.customSrtOriginalText !== undefined) {
                textSpan.textContent = textSpan.dataset.customSrtOriginalText;
                delete textSpan.dataset.customSrtOriginalText;
            }
            row.classList.remove("custom-srt-caption-search-match", "custom-srt-caption-search-current");
        });
    }

    function highlightTranscriptRow(row, terms) {
        const textSpan = row.querySelector(".event-text span");
        if (!textSpan) return;

        if (textSpan.dataset.customSrtOriginalText === undefined) {
            textSpan.dataset.customSrtOriginalText = textSpan.textContent || "";
        }

        textSpan.innerHTML = highlightMatches(textSpan.dataset.customSrtOriginalText, terms);
        row.classList.add("custom-srt-caption-search-match");
    }

    function highlightCustomCaptionSearch(query) {
        const ariaMessage = document.querySelector("#searchResultsAria");
        const matches = findCustomCaptionMatches(query);
        const terms = getCustomSearchTerms(query);
        let firstMatchedRow = null;
        let highlightedCount = 0;

        clearCaptionSearchHighlights();
        selectTranscriptTab();

        for (const { caption } of matches) {
            const row = findTranscriptRowByTime(captionStartTime(caption));
            if (!row) continue;

            highlightTranscriptRow(row, terms);
            if (!firstMatchedRow) firstMatchedRow = row;
            highlightedCount++;
        }

        if (firstMatchedRow) {
            firstMatchedRow.classList.add("custom-srt-caption-search-current");
            firstMatchedRow.scrollIntoView({ behavior: "smooth", block: "center" });
            firstMatchedRow.focus({ preventScroll: true });
        }

        if (ariaMessage) {
            ariaMessage.textContent = highlightedCount
                ? `${highlightedCount} custom SRT caption result${highlightedCount === 1 ? "" : "s"} highlighted`
                : "No custom SRT caption results";
        }

        return true;
    }

    function shouldHandleCustomSearch() {
        if (!isCustomSrtActive || !Array.isArray(injectedCaptions)) return false;

        const searchType = document.querySelector("#searchTypeSelect");
        const selectedType = searchType ? searchType.value : "";
        return selectedType === "" || selectedType === "transcript";
    }

    function runCustomSearch(event) {
        if (!shouldHandleCustomSearch()) return;

        const input = document.querySelector("#searchInput");
        const query = input ? input.value.trim() : "";
        if (!query) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        highlightCustomCaptionSearch(query);
    }

    function clearCustomSearch(event) {
        if (!isCustomSrtActive) return;

        const ariaMessage = document.querySelector("#searchResultsAria");
        const input = document.querySelector("#searchInput");
        if (input) input.value = "";
        if (ariaMessage) ariaMessage.textContent = "";
        clearCaptionSearchHighlights();
        selectTranscriptTab();

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }

    function initCustomSearch() {
        if (!isCustomSrtActive || document.documentElement.dataset.customSrtSearchInjected) return;

        const searchInput = document.querySelector("#searchInput");
        const searchButton = document.querySelector("#searchButton");
        const placeholderSearchButton = document.querySelector("#placeholderSearchButton");
        const clearButton = document.querySelector("#clearButton");
        if (!searchInput || !searchButton) return;

        document.documentElement.dataset.customSrtSearchInjected = "true";
        searchInput.title = "Search custom SRT captions";
        searchInput.placeholder = "Search custom SRT captions";
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") runCustomSearch(e);
        }, true);
        searchButton.addEventListener("click", runCustomSearch, true);
        if (placeholderSearchButton) placeholderSearchButton.addEventListener("click", runCustomSearch, true);
        if (clearButton) clearButton.addEventListener("click", clearCustomSearch, true);
    }

    /* -----------------------------
       UI Components
    ----------------------------- */
    function applySharedStyles(btn) {
        btn.type = "button"; // CRITICAL FIX: Stops button from being triggered by Enter in search forms
        btn.style.marginRight = "12px";
        btn.style.padding = "6px 12px";
        btn.style.color = "white";
        btn.style.border = "none";
        btn.style.borderRadius = "4px";
        btn.style.cursor = "pointer";
        btn.style.fontSize = "14px";
        btn.style.fontWeight = "500";
        btn.style.height = "fit-content";
        btn.style.alignSelf = "center";
        btn.style.display = "inline-flex";
        btn.style.alignItems = "center";
        btn.style.textDecoration = "none";
        btn.style.boxSizing = "border-box";
    }

    function saveAndRefresh(captions) {
        const now = new Date();
        const formattedDate = new Intl.DateTimeFormat('en-GB', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).format(now);

        const dataToStore = {
            captions: captions,
            timestamp: formattedDate
        };
        GM_setValue(videoUUID || getVideoId(), JSON.stringify(dataToStore));
        refreshPage();
    }

    function createUploadButton() {
        const btn = document.createElement("button");
        applySharedStyles(btn);
        btn.textContent = isCustomSrtActive ? "Replace SRT" : "Upload SRT";
        btn.style.backgroundColor = "#1976d2";
        btn.onclick = (e) => {
            e.stopPropagation();
            const input = document.createElement("input");
            input.type = "file"; input.accept = ".srt";
            input.onchange = () => {
                const reader = new FileReader();
                reader.onload = () => saveAndRefresh(parseSRT(reader.result));
                reader.readAsText(input.files[0]);
            };
            input.click();
        };
        return btn;
    }

    function createClearButton() {
        const btn = document.createElement("button");
        applySharedStyles(btn);
        btn.textContent = "Revert to Default";
        btn.style.backgroundColor = "#d32f2f";
        btn.onclick = (e) => {
            e.stopPropagation();
            GM_deleteValue(videoUUID || getVideoId());
            refreshPage();
        };
        return btn;
    }

    function createDownloadButton() {
        const uuid = videoUUID || getVideoId();
        if (!uuid) return null;
        const btn = document.createElement("a");
        applySharedStyles(btn);
        btn.textContent = "Download";
        btn.href = `https://auckland.au.panopto.com/Panopto/Podcast/Download/${uuid}.mp4?mediaTargetType=audioPodcast`;
        btn.download = `AudioPodcast-${uuid}.mp4`;
        btn.target = "_blank";
        btn.style.backgroundColor = "#2e7d32";
        return btn;
    }

    /* -----------------------------
       Drag and Drop & Status UI
    ----------------------------- */
    function initDragAndDrop() {
        const overlay = document.createElement("div");
        overlay.style.cssText = `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(25, 118, 210, 0.85); color: white; display: flex; align-items: center; justify-content: center; font-size: 36px; font-weight: bold; z-index: 999999; pointer-events: none; opacity: 0; transition: opacity 0.2s;`;
        overlay.textContent = "Drop .srt file here to apply captions";
        document.body.appendChild(overlay);

        window.addEventListener("dragover", (e) => { e.preventDefault(); overlay.style.opacity = "1"; });
        window.addEventListener("dragleave", (e) => { if (e.relatedTarget === null || e.relatedTarget.nodeName === "HTML") overlay.style.opacity = "0"; });
        window.addEventListener("drop", (e) => {
            e.preventDefault(); overlay.style.opacity = "0";
            const file = e.dataTransfer.files[0];
            if (file && file.name.toLowerCase().endsWith(".srt")) {
                const reader = new FileReader();
                reader.onload = () => saveAndRefresh(parseSRT(reader.result));
                reader.readAsText(file);
            }
        });
    }

    /* -----------------------------
       DOM Observer
    ----------------------------- */
    function startObservers() {
        const observer = new MutationObserver(() => {
            initCustomSearch();

            const headerRight = document.querySelector("#header-right-react .css-h26irz");
            if (headerRight && !headerRight.dataset.srtInjected) {
                headerRight.dataset.srtInjected = "true";
                const downloadBtn = createDownloadButton();
                if (downloadBtn) headerRight.prepend(downloadBtn);
                if (isCustomSrtActive) headerRight.prepend(createClearButton());
                headerRight.prepend(createUploadButton());
            }

            if (isCustomSrtActive) {
                const warningSpan = document.querySelector(".css-b93d1p .css-1i5jedo");
                if (warningSpan && !warningSpan.dataset.statusSwapped) {
                    warningSpan.dataset.statusSwapped = "true";
                    const timeInfo = uploadTimestamp ? ` (Uploaded: ${uploadTimestamp})` : "";
                    warningSpan.textContent = `Custom SRT is active${timeInfo}`;
                    warningSpan.parentElement.style.color = "#1976d2";
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        initCustomSearch();
    }

    GM_addStyle(`
        #transcriptTabPane .custom-srt-caption-search-match > .index-event-row {
            background: rgba(255, 235, 59, 0.18);
        }
        #transcriptTabPane .custom-srt-caption-search-current > .index-event-row {
            outline: 2px solid #1976d2;
            outline-offset: -2px;
        }
        #transcriptTabPane .custom-srt-caption-search-match .search-match {
            background: rgba(255, 235, 59, 0.55);
            color: inherit;
            font-weight: 600;
        }
    `);

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => { startObservers(); initDragAndDrop(); });
    } else {
        startObservers();
        initDragAndDrop();
    }

})();

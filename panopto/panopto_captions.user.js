// ==UserScript==
// @name         Custom .srt captions - panopto.com
// @namespace    https://github.com/Silverarmor
// @version      0.1.17
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

    console.log("[PanoptoCC] Script booting at v0.1.17");

    let injectedCaptions = null;
    let isCustomSrtActive = false;
    let uploadTimestamp = null;
    let videoUUID = null;
    // The fetch proxy only works if this script is injected before the viewer
    // requests captions. Track whether interception actually happened so a
    // lost race can be detected and recovered from (see checkInjectionHealth).
    let interceptedCaptions = false;
    let injectionFailed = false;
    let injectionRetryHandled = false;

    const MAX_INJECTION_RETRIES = 2;

    function retryCountKey() {
        return "panoptocc-retry-" + (videoUUID || "unknown");
    }

    function getRetryCount() {
        try { return parseInt(sessionStorage.getItem(retryCountKey()), 10) || 0; } catch (e) { return 0; }
    }

    function setRetryCount(value) {
        try {
            if (value > 0) sessionStorage.setItem(retryCountKey(), String(value));
            else sessionStorage.removeItem(retryCountKey());
        } catch (e) { }
    }

    /* -----------------------------
       GM Storage handoff
       In Tampermonkey's "UserScripts API Dynamic" mode, GM values are
       injected as a snapshot that can lag one reload behind a fresh
       GM_setValue/GM_deleteValue. Mirror the latest save/revert in
       sessionStorage (synchronous, same-tab) so the reload right after an
       upload or revert sees the new state; drop the mirror once GM storage
       has caught up.
    ----------------------------- */
    const DELETED_SENTINEL = "__PANOPTOCC_DELETED__";

    function pendingValueKey(uuid) {
        return "panoptocc-pending-" + uuid;
    }

    function writeCaptionStore(uuid, serialized) {
        if (serialized === null) {
            GM_deleteValue(uuid);
            try { sessionStorage.setItem(pendingValueKey(uuid), DELETED_SENTINEL); } catch (e) { }
        } else {
            GM_setValue(uuid, serialized);
            try { sessionStorage.setItem(pendingValueKey(uuid), serialized); } catch (e) { }
        }
    }

    function readCaptionStore(uuid) {
        let stored = null;
        try { stored = GM_getValue(uuid, null); } catch (e) { }

        let pending = null;
        try { pending = sessionStorage.getItem(pendingValueKey(uuid)); } catch (e) { }
        if (pending === null) return stored;

        const pendingValue = pending === DELETED_SENTINEL ? null : pending;
        if (stored === pendingValue) {
            try { sessionStorage.removeItem(pendingValueKey(uuid)); } catch (e) { }
        }
        return pendingValue;
    }

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
            const storedData = readCaptionStore(videoUUID);
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
                    interceptedCaptions = true;
                    setRetryCount(0);
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

    function formatDuration(seconds) {
        const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const secs = safeSeconds % 60;
        if (hours > 0) {
            return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        }
        return `${minutes}:${String(secs).padStart(2, "0")}`;
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

    function getCaptionEndTime(caption) {
        return captionStartTime(caption) + (Number(caption && caption.CaptionDuration) || 0);
    }

    function findCaptionAtTime(seconds) {
        if (!Array.isArray(injectedCaptions) || !injectedCaptions.length) return null;

        const time = Math.max(0, Number(seconds) || 0);
        const indexedCaptions = injectedCaptions.map((caption, index) => ({ caption, index }));
        const activeCaption = indexedCaptions.find(({ caption }) => {
            const start = captionStartTime(caption);
            const end = getCaptionEndTime(caption);
            return time >= start && time <= Math.max(start, end);
        });
        if (activeCaption) return activeCaption;

        const previousCaption = indexedCaptions
            .filter(({ caption }) => captionStartTime(caption) <= time)
            .sort((a, b) => captionStartTime(b.caption) - captionStartTime(a.caption))[0];
        if (previousCaption) return previousCaption;

        return indexedCaptions[0];
    }

    function getTranscriptRows() {
        return Array.from(document.querySelectorAll("#transcriptTabPane li[id^='UserCreatedTranscript-']"));
    }

    function findTranscriptRowByTime(seconds, fallbackIndex) {
        const targetMillis = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
        const rows = getTranscriptRows();
        const timeMatchedRow = rows
            .map((row) => {
                const match = row.id.match(/^UserCreatedTranscript-(\d+)/);
                return match ? { row, delta: Math.abs(Number(match[1]) - targetMillis) } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.delta - b.delta)[0];

        if (timeMatchedRow && timeMatchedRow.delta <= 1000) return timeMatchedRow.row;
        return Number.isInteger(fallbackIndex) ? rows[fallbackIndex] : null;
    }

    function selectTranscriptTab() {
        const transcriptTabHeader = document.querySelector("#transcriptTabHeader");
        const transcriptTabPane = document.querySelector("#transcriptTabPane");
        if (!transcriptTabHeader || !transcriptTabPane) return;

        if (!transcriptTabHeader.classList.contains("selected")) {
            transcriptTabHeader.click();
        }

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

    function selectSearchResultsTab() {
        const searchTabHeader = document.querySelector("#searchTabHeader");
        const searchTabPane = document.querySelector("#searchTabPane");
        if (!searchTabHeader || !searchTabPane) return;

        document.querySelectorAll("#eventTabControl .event-tab-header").forEach((tab) => {
            tab.classList.remove("selected");
            tab.setAttribute("aria-selected", "false");
            tab.setAttribute("tabindex", "-1");
        });

        document.querySelectorAll("#eventTabPanes .event-tab-pane").forEach((pane) => {
            pane.style.display = "none";
        });

        searchTabHeader.style.display = "";
        searchTabHeader.classList.add("selected");
        searchTabHeader.setAttribute("aria-selected", "true");
        searchTabHeader.setAttribute("tabindex", "0");
        searchTabPane.style.display = "";
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

    function activateCustomCaptionResult(caption, terms, captionIndex, shouldSeek = true) {
        const start = captionStartTime(caption);

        clearCaptionSearchHighlights();
        selectTranscriptTab();

        const activateRow = (shouldClick) => {
            const row = findTranscriptRowByTime(start, captionIndex);
            if (!row) return false;

            if (shouldClick && shouldSeek) row.click();
            highlightTranscriptRow(row, terms);
            row.classList.add("custom-srt-caption-search-current");
            row.scrollIntoView({ behavior: "smooth", block: "center" });
            row.focus({ preventScroll: true });
            return true;
        };

        if (!activateRow(true) && shouldSeek) {
            const video = document.querySelector("video");
            if (video) {
                video.currentTime = start;
                video.play().catch(() => { });
            }
        }

        setTimeout(() => activateRow(false), 75);
        setTimeout(() => activateRow(false), 250);
        setTimeout(() => activateRow(false), 600);
    }

    function jumpToCurrentCaption(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        const video = document.querySelector("video");
        if (!video) return;

        const match = findCaptionAtTime(video.currentTime);
        if (!match) return;

        activateCustomCaptionResult(match.caption, [], match.index, false);
    }

    function createJumpToCurrentCaptionButton() {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "custom-srt-jump-current-caption MuiButtonBase-root MuiIconButton-root MuiIconButton-sizeMedium";
        btn.setAttribute("aria-label", "Jump to current caption");
        btn.title = "Jump to current caption";
        btn.innerHTML = `
            <svg viewBox="0 0 24 24" role="presentation" style="width: 24px; height: 24px;">
                <path d="M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M3.05,13H1V11H3.05A9,9 0 0,1 11,3.05V1H13V3.05A9,9 0 0,1 20.95,11H23V13H20.95A9,9 0 0,1 13,20.95V23H11V20.95A9,9 0 0,1 3.05,13M12,5A7,7 0 0,0 5,12A7,7 0 0,0 12,19A7,7 0 0,0 19,12A7,7 0 0,0 12,5Z" style="fill: currentcolor;"></path>
            </svg>
        `;
        btn.addEventListener("click", jumpToCurrentCaption);
        return btn;
    }

    function initJumpToCurrentCaptionButton() {
        if (!isCustomSrtActive) return;

        const header = document.querySelector("#transcriptPaneHeader .event-tab-pane-header");
        if (!header || header.querySelector(".custom-srt-jump-current-caption")) return;

        const downloadTranscriptButton = header.querySelector("button[aria-label='Download transcript']");
        const jumpButton = createJumpToCurrentCaptionButton();
        if (downloadTranscriptButton) {
            header.insertBefore(jumpButton, downloadTranscriptButton);
        } else {
            header.appendChild(jumpButton);
        }
    }

    function renderCustomSearchResults(query) {
        const resultsList = document.querySelector("#searchTabPane .event-tab-list");
        const message = document.querySelector("#searchResultsMessage");
        const ariaMessage = document.querySelector("#searchResultsAria");
        if (!resultsList || !message) return false;

        const matches = findCustomCaptionMatches(query);
        const terms = getCustomSearchTerms(query);

        resultsList.textContent = "";
        clearCaptionSearchHighlights();
        updateSearchClearButton();
        message.textContent = matches.length
            ? `${matches.length} custom SRT caption result${matches.length === 1 ? "" : "s"}`
            : "No custom SRT caption results";
        if (ariaMessage) ariaMessage.textContent = message.textContent;

        for (const { caption, index } of matches) {
            const start = captionStartTime(caption);
            const row = document.createElement("li");
            row.id = `customSrtSearch-${Math.round(start * 1000)}-${index}`;
            row.className = "index-event custom-srt-search-result";
            row.tabIndex = index === 0 ? 0 : -1;
            row.innerHTML = `
                <div class="event-error">
                    <span class="event-error-message"></span>
                    <a class="event-error-retry" tabindex="0">Retry</a>
                    <a class="event-error-cancel" tabindex="0">Cancel</a>
                </div>
                <div class="index-event-row">
                    <div aria-label="Custom SRT Caption"></div>
                    <div class="event-text" dir="auto">
                        <span>${highlightMatches(caption.Caption, terms)}</span>
                        <div class="event-timestamp"></div>
                    </div>
                    <div class="event-time">${formatDuration(start)}</div>
                </div>
            `;
            row.addEventListener("click", () => activateCustomCaptionResult(caption, terms, index));
            row.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activateCustomCaptionResult(caption, terms, index);
                }
            });
            resultsList.appendChild(row);
        }

        selectSearchResultsTab();
        return true;
    }

    function updateCustomSearchIndicator() {
        const searchPaneHeader = document.querySelector("#searchPaneHeader");
        const message = document.querySelector("#searchResultsMessage");
        if (!searchPaneHeader || !message) return;

        let indicator = document.querySelector("#customSrtSearchIndicator");
        const timeInfo = uploadTimestamp ? ` Uploaded ${uploadTimestamp}.` : "";
        const indicatorText = `Showing results from uploaded custom SRT.${timeInfo}`;

        if (!indicator) {
            indicator = document.createElement("div");
            indicator.id = "customSrtSearchIndicator";
            message.insertAdjacentElement("afterend", indicator);
        }

        if (indicator.textContent !== indicatorText) {
            indicator.textContent = indicatorText;
        }
    }

    function updateSearchClearButton() {
        const searchRegion = document.querySelector("#searchRegion");
        const searchInput = document.querySelector("#searchInput");
        if (!searchRegion || !searchInput) return;

        searchRegion.classList.add("custom-srt-search-active");
        searchRegion.classList.toggle("custom-srt-has-query", !!searchInput.value.trim());
    }

    function lockCustomSearchControls() {
        const searchPaneHeader = document.querySelector("#searchPaneHeader");
        const searchTypeSelect = document.querySelector("#searchTypeSelect");
        const searchSortSelect = document.querySelector("#searchSortSelect");
        if (!searchPaneHeader && !searchTypeSelect && !searchSortSelect) return;

        if (searchPaneHeader && !searchPaneHeader.classList.contains("custom-srt-controls-locked")) {
            searchPaneHeader.classList.add("custom-srt-controls-locked");
        }
        updateCustomSearchIndicator();

        if (searchTypeSelect) {
            if (searchTypeSelect.value !== "") searchTypeSelect.value = "";
            if (!searchTypeSelect.disabled) searchTypeSelect.disabled = true;
            if (searchTypeSelect.tabIndex !== -1) searchTypeSelect.tabIndex = -1;
            if (searchTypeSelect.getAttribute("aria-hidden") !== "true") {
                searchTypeSelect.setAttribute("aria-hidden", "true");
            }
        }

        if (searchSortSelect) {
            if (searchSortSelect.value !== "time") searchSortSelect.value = "time";
            if (!searchSortSelect.disabled) searchSortSelect.disabled = true;
            if (searchSortSelect.tabIndex !== -1) searchSortSelect.tabIndex = -1;
            if (searchSortSelect.getAttribute("aria-hidden") !== "true") {
                searchSortSelect.setAttribute("aria-hidden", "true");
            }
        }
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
        renderCustomSearchResults(query);
    }

    function clearCustomSearch(event) {
        if (!isCustomSrtActive) return;

        const ariaMessage = document.querySelector("#searchResultsAria");
        const input = document.querySelector("#searchInput");
        const message = document.querySelector("#searchResultsMessage");
        const resultsList = document.querySelector("#searchTabPane .event-tab-list");
        if (input) input.value = "";
        if (message) message.textContent = "Type a keyword and hit Enter to search";
        if (resultsList) resultsList.textContent = "";
        if (ariaMessage) ariaMessage.textContent = "";
        clearCaptionSearchHighlights();
        updateSearchClearButton();
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
        if (clearButton) clearButton.title = "Clear custom SRT search";
        updateSearchClearButton();
        lockCustomSearchControls();
        searchInput.addEventListener("input", updateSearchClearButton, true);
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
        btn.style.whiteSpace = "nowrap";
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
        writeCaptionStore(videoUUID || getVideoId(), JSON.stringify(dataToStore));
        setRetryCount(0);
        refreshPage();
    }

    function createUploadButton() {
        const btn = document.createElement("button");
        applySharedStyles(btn);
        btn.textContent = isCustomSrtActive ? "Replace" : "Upload";
        btn.title = isCustomSrtActive ? "Replace SRT" : "Upload SRT";
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
        btn.textContent = "Revert";
        btn.title = "Revert to Default";
        btn.style.backgroundColor = "#d32f2f";
        btn.onclick = (e) => {
            e.stopPropagation();
            writeCaptionStore(videoUUID || getVideoId(), null);
            setRetryCount(0);
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
        btn.title = "Download audio podcast MP4";
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
       Injection Health Check
    ----------------------------- */
    // If the viewer rendered its transcript without our fetch proxy ever
    // intercepting the captions request, this script was injected too late
    // (Tampermonkey injection race) and Panopto's original captions are
    // showing. Reload to retry; give up after MAX_INJECTION_RETRIES.
    function checkInjectionHealth() {
        if (!isCustomSrtActive || interceptedCaptions || injectionRetryHandled) return;
        if (!getTranscriptRows().length) return;

        injectionRetryHandled = true;
        const attempts = getRetryCount();
        if (attempts < MAX_INJECTION_RETRIES) {
            setRetryCount(attempts + 1);
            console.warn(`[PanoptoCC] Captions request was not intercepted (injected too late). Reloading to retry (${attempts + 1}/${MAX_INJECTION_RETRIES})`);
            refreshPage();
        } else {
            injectionFailed = true;
            console.error("[PanoptoCC] Could not intercept the captions request after retries - Panopto's original captions are showing.");
        }
    }

    /* -----------------------------
       DOM Observer
    ----------------------------- */
    function startObservers() {
        const observer = new MutationObserver(() => {
            checkInjectionHealth();
            initCustomSearch();
            if (isCustomSrtActive) lockCustomSearchControls();
            initJumpToCurrentCaptionButton();

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
                if (warningSpan) {
                    const timeInfo = uploadTimestamp ? ` (Uploaded: ${uploadTimestamp})` : "";
                    const statusText = injectionFailed
                        ? "Custom SRT failed to apply - Panopto's captions are showing. Reload to retry."
                        : `Custom SRT is active${timeInfo}`;
                    if (warningSpan.textContent !== statusText) {
                        warningSpan.textContent = statusText;
                        warningSpan.parentElement.style.color = injectionFailed ? "#d32f2f" : "#1976d2";
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        checkInjectionHealth();
        initCustomSearch();
        if (isCustomSrtActive) lockCustomSearchControls();
        initJumpToCurrentCaptionButton();
    }

    GM_addStyle(`
        #logoContainer.small-logo {
            display: none !important;
        }
        #viewerHeader .header-left {
            flex: 1 1 auto !important;
            min-width: 0 !important;
            overflow: hidden !important;
        }
        #deliveryTitle {
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
        }
        #searchRegion.custom-srt-search-active {
            position: relative;
        }
        #searchRegion.custom-srt-search-active.custom-srt-has-query #clearButton {
            align-items: center !important;
            display: flex !important;
            height: 100% !important;
            justify-content: center !important;
            margin: 0 !important;
            visibility: visible !important;
            opacity: 1 !important;
            position: absolute !important;
            right: 36px !important;
            top: 50% !important;
            transform: translateY(-50%) !important;
        }
        #searchRegion.custom-srt-search-active:not(.custom-srt-has-query) #clearButton {
            display: none !important;
        }
        #searchPaneHeader.custom-srt-controls-locked #searchTypeSelect,
        #searchPaneHeader.custom-srt-controls-locked #searchSortSelect {
            display: none !important;
        }
        #searchPaneHeader.custom-srt-controls-locked {
            min-height: 0 !important;
        }
        #customSrtSearchIndicator {
            color: #1976d2;
            font-size: 12px;
            font-weight: 500;
            line-height: 1.35;
            margin: 2px 0 8px;
        }
        #transcriptPaneHeader .event-tab-pane-header {
            align-items: center !important;
            display: flex !important;
            flex-wrap: nowrap !important;
            min-width: 0 !important;
        }
        #transcriptPaneHeader .event-tab-pane-header > div:first-child {
            flex: 1 1 auto !important;
            min-width: 0 !important;
            overflow: hidden !important;
        }
        #transcriptPaneHeader .css-b93d1p {
            min-width: 0 !important;
        }
        #transcriptPaneHeader .css-b93d1p .css-1i5jedo {
            display: inline-block !important;
            min-width: 0 !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
        }
        #transcriptPaneHeader button[aria-label="Download transcript"],
        .custom-srt-jump-current-caption {
            align-items: center;
            background: transparent;
            border: 0;
            border-radius: 50%;
            color: inherit;
            cursor: pointer;
            display: inline-flex;
            flex: 0 0 36px !important;
            height: 36px !important;
            justify-content: center;
            margin-left: 4px;
            min-width: 36px !important;
            padding: 6px !important;
            vertical-align: middle;
            width: 36px !important;
        }
        #transcriptPaneHeader button[aria-label="Download transcript"]:hover,
        #transcriptPaneHeader button[aria-label="Download transcript"]:focus,
        .custom-srt-jump-current-caption:hover,
        .custom-srt-jump-current-caption:focus {
            background: rgba(0, 0, 0, 0.08);
            outline: none;
        }
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
        .custom-srt-search-result .search-match {
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

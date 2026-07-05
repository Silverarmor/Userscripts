// ==UserScript==
// @name         HelloFresh Chat Enhancer (Fullscreen & Download)
// @namespace    https://github.com/Silverarmor
// @version      1.1
// @description  Adds a fullscreen mode to the HelloFresh chat window and a download button for transcripts.
// @author       You
// @match        *://*.hellofresh.co.nz/*
// @match        *://*.hellofresh.com/*
// @match        *://*.hellofresh.com.au/*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/hellofresh/hellofresh_chat_enhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/hellofresh/hellofresh_chat_enhancer.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 1. Inject aggressive CSS to force the widget to expand
    const style = document.createElement('style');
    style.innerHTML = `
        /* Force the main container to fill the screen */
        .hf-chat-fullscreen-active {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            max-width: 100vw !important;
            max-height: 100vh !important;
            z-index: 9999999 !important;
            border-radius: 0 !important;
            margin: 0 !important;
            transform: none !important;
            background: #ffffff !important;
        }
        
        /* Force the inner layout wrappers to stretch */
        .hf-chat-fullscreen-active > div,
        .hf-chat-fullscreen-active > div > div,
        .hf-chat-fullscreen-active > div > div > div {
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            border-radius: 0 !important;
        }
    `;
    document.head.appendChild(style);

    // 2. Create the floating control panel
    const panel = document.createElement('div');
    panel.style.position = 'fixed';
    panel.style.bottom = '20px';
    panel.style.left = '20px'; // Positioned on the left so it doesn't block the chat widget on the right
    panel.style.zIndex = '9999999';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.gap = '10px';

    const btnFullscreen = document.createElement('button');
    btnFullscreen.innerText = '⛶ Toggle Chat Fullscreen';
    styleButton(btnFullscreen);

    const btnDownload = document.createElement('button');
    btnDownload.innerText = '📥 Download Transcript';
    styleButton(btnDownload);

    panel.appendChild(btnFullscreen);
    panel.appendChild(btnDownload);
    document.body.appendChild(panel);

    // Helper to apply nice styling to the buttons
    function styleButton(btn) {
        btn.style.padding = '10px 15px';
        btn.style.background = '#067A46'; // Matches HelloFresh brand green
        btn.style.color = '#fff';
        btn.style.border = 'none';
        btn.style.borderRadius = '8px';
        btn.style.cursor = 'pointer';
        btn.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
        btn.style.fontFamily = 'sans-serif';
        btn.style.fontWeight = 'bold';
        btn.style.fontSize = '14px';
    }

    let isFullscreen = false;
    let targetContainer = null;

    // 3. Fullscreen Toggle Logic
    btnFullscreen.addEventListener('click', () => {
        // Find a recognizable element inside the chat to anchor ourselves
        const chatBubble = document.querySelector('[data-testid="chat-message-bubble"]');
        if (!chatBubble) {
            alert('Please open the chat window and wait for it to load first!');
            return;
        }

        // Ascend the DOM tree to find the absolute/fixed container housing the widget
        if (!targetContainer) {
            let container = chatBubble;
            let found = false;
            while (container && container !== document.body) {
                const computed = window.getComputedStyle(container);
                if (computed.position === 'fixed' || computed.position === 'absolute' || container.getAttribute('role') === 'dialog') {
                    targetContainer = container;
                    found = true;
                    break;
                }
                container = container.parentElement;
            }

            // Fallback: If we can't find a fixed container, just grab the wrapper a few levels up
            if (!found) {
                targetContainer = chatBubble.parentElement.parentElement.parentElement.parentElement;
            }
        }

        if (!isFullscreen) {
            targetContainer.classList.add('hf-chat-fullscreen-active');
            btnFullscreen.innerText = '↙️ Exit Fullscreen';
            isFullscreen = true;
        } else {
            targetContainer.classList.remove('hf-chat-fullscreen-active');
            btnFullscreen.innerText = '⛶ Toggle Chat Fullscreen';
            isFullscreen = false;
        }
    });

    // 4. Transcript Download Logic
    btnDownload.addEventListener('click', () => {
        const messageNodes = document.querySelectorAll('[data-testid^="chat-message-"]');
        if (messageNodes.length === 0) {
            alert("No chat messages found! Please open the chat window first.");
            return;
        }

        let transcript = "--- Chat Transcript ---\n\n";

        messageNodes.forEach(node => {
            const typeAttr = node.getAttribute('data-testid');
            const sender = typeAttr.replace('chat-message-', '').toUpperCase();

            const textNode = node.querySelector('[data-testid="chat-message-bubble"]');
            const timeNode = node.querySelector('[data-testid="chat-message-timestamp"]');

            let timeStr = timeNode ? timeNode.innerText.trim() : '';
            let msgStr = textNode ? textNode.innerText.trim() : '';

            // Strip the timestamp out of the message text if it got captured by innerText
            if (timeStr && msgStr.endsWith(timeStr)) {
                msgStr = msgStr.substring(0, msgStr.length - timeStr.length).trim();
            }

            transcript += `[${timeStr}] ${sender}:\n${msgStr}\n\n`;
        });

        // Trigger the file download
        const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat_transcript_${new Date().toISOString().slice(0,10)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });
})();
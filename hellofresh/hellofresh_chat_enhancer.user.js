// ==UserScript==
// @name         HelloFresh Chat Enhancer (Fullscreen & Download)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds a fullscreen mode to the HelloFresh chat window and a download button for transcripts.
// @author       You
// @match        *://*.hellofresh.co.nz/*
// @match        *://*.hellofresh.com/*
// @match        *://*.hellofresh.com.au/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 1. Create the floating control panel
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
    let originalStyles = new Map();

    // 2. Fullscreen Toggle Logic
    btnFullscreen.addEventListener('click', () => {
        // Find a recognizable element inside the chat to anchor ourselves
        const chatBubble = document.querySelector('[data-testid="chat-message-bubble"]');
        if (!chatBubble) {
            alert('Please open the chat window and wait for it to load first!');
            return;
        }

        // Ascend the DOM tree to find the absolute/fixed container housing the widget
        let container = chatBubble;
        let found = false;
        while (container && container !== document.body) {
            const style = window.getComputedStyle(container);
            if (style.position === 'fixed' || style.position === 'absolute' || container.getAttribute('role') === 'dialog') {
                found = true;
                break;
            }
            container = container.parentElement;
        }

        if (!found) {
            // Fallback just in case the DOM structure slightly changes
            container = chatBubble.parentElement.parentElement.parentElement.parentElement;
        }

        if (!isFullscreen) {
            // Save the original sizing and positioning
            originalStyles.set(container, {
                width: container.style.width,
                height: container.style.height,
                maxWidth: container.style.maxWidth,
                maxHeight: container.style.maxHeight,
                top: container.style.top,
                left: container.style.left,
                right: container.style.right,
                bottom: container.style.bottom,
                borderRadius: container.style.borderRadius,
                zIndex: container.style.zIndex
            });

            // Force the container to take up the whole screen
            container.style.position = 'fixed';
            container.style.width = '100vw';
            container.style.height = '100vh';
            container.style.maxWidth = '100vw';
            container.style.maxHeight = '100vh';
            container.style.top = '0';
            container.style.left = '0';
            container.style.right = '0';
            container.style.bottom = '0';
            container.style.borderRadius = '0';
            container.style.zIndex = '999999';

            btnFullscreen.innerText = '↙️ Exit Fullscreen';
            isFullscreen = true;
        } else {
            // Restore the original styles
            const orig = originalStyles.get(container);
            if (orig) {
                container.style.width = orig.width;
                container.style.height = orig.height;
                container.style.maxWidth = orig.maxWidth;
                container.style.maxHeight = orig.maxHeight;
                container.style.top = orig.top;
                container.style.left = orig.left;
                container.style.right = orig.right;
                container.style.bottom = orig.bottom;
                container.style.borderRadius = orig.borderRadius;
                container.style.zIndex = orig.zIndex;
            }
            btnFullscreen.innerText = '⛶ Toggle Chat Fullscreen';
            isFullscreen = false;
        }
    });

    // 3. Transcript Download Logic
    btnDownload.addEventListener('click', () => {
        // Find all chat messages using the data-testid attributes
        const messageNodes = document.querySelectorAll('[data-testid^="chat-message-"]');
        if (messageNodes.length === 0) {
            alert("No chat messages found! Please open the chat window first.");
            return;
        }

        let transcript = "--- Chat Transcript ---\n\n";

        messageNodes.forEach(node => {
            // This grabs whether it's chat-message-user, chat-message-bot, or chat-message-agent
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
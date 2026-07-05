// ==UserScript==
// @name         HelloFresh Chat Downloader
// @namespace    https://github.com/Silverarmor
// @version      2.0
// @description  Downloads a cleaned HelloFresh chat transcript
// @author       You
// @match        *://*.hellofresh.co.nz/*
// @match        *://*.hellofresh.com/*
// @match        *://*.hellofresh.com.au/*
// @homepageURL  https://github.com/Silverarmor/Userscripts
// @updateURL    https://raw.githubusercontent.com/Silverarmor/Userscripts/master/hellofresh/hellofresh_chat_enhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/Silverarmor/Userscripts/master/hellofresh/hellofresh_chat_enhancer.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // -----------------------------
    // Floating control button
    // -----------------------------
    const panel = document.createElement('div');
    panel.style.position = 'fixed';
    panel.style.bottom = '20px';
    panel.style.left = '20px';
    panel.style.zIndex = '9999999';
    panel.style.display = 'flex';

    const btnDownload = document.createElement('button');
    btnDownload.innerText = '📥 Download Transcript';

    styleButton(btnDownload);

    panel.appendChild(btnDownload);
    document.body.appendChild(panel);

    function styleButton(btn) {
        btn.style.padding = '10px 15px';
        btn.style.background = '#067A46';
        btn.style.color = '#fff';
        btn.style.border = 'none';
        btn.style.borderRadius = '8px';
        btn.style.cursor = 'pointer';
        btn.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
        btn.style.fontFamily = 'sans-serif';
        btn.style.fontWeight = 'bold';
        btn.style.fontSize = '14px';
    }

    // -----------------------------
    // Download logic (cleaned)
    // -----------------------------
    btnDownload.addEventListener('click', () => {
        const messageNodes = document.querySelectorAll('[data-testid^="chat-message-"]');

        if (messageNodes.length === 0) {
            alert("No chat messages found! Please open the chat window first.");
            return;
        }

        let transcript = "--- Chat Transcript ---\n\n";
        const cleanedMessages = [];

        messageNodes.forEach(node => {
            const typeAttr = node.getAttribute('data-testid') || '';
            const sender = typeAttr.replace('chat-message-', '').toUpperCase();

            const textNode = node.querySelector('[data-testid="chat-message-bubble"]');
            const timeNode = node.querySelector('[data-testid="chat-message-timestamp"]');

            let timeStr = timeNode?.innerText?.trim() || '';
            let msgStr = textNode?.innerText?.trim() || '';

            // Skip junk / empty nodes
            if (!msgStr || msgStr === '' || msgStr.toUpperCase() === 'BUBBLE') return;

            // Remove duplicated timestamp inside message
            if (timeStr && msgStr.endsWith(timeStr)) {
                msgStr = msgStr.slice(0, -timeStr.length).trim();
            }

            // Remove UI noise
            const noisePatterns = [
                /^Track/i,
                /^Open Survey/i,
                /^Before you go/i
            ];

            if (noisePatterns.some(p => p.test(msgStr))) return;

            cleanedMessages.push({ timeStr, sender, msgStr });
        });

        // Merge consecutive messages from same sender/time
        let last = null;

        cleanedMessages.forEach(m => {
            if (last && last.sender === m.sender && last.timeStr === m.timeStr) {
                last.msgStr += "\n" + m.msgStr;
            } else {
                if (last) {
                    transcript += `[${last.timeStr}] ${last.sender}:\n${last.msgStr}\n\n`;
                }
                last = { ...m };
            }
        });

        if (last) {
            transcript += `[${last.timeStr}] ${last.sender}:\n${last.msgStr}\n\n`;
        }

        // Download file
        const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `chat_transcript_${new Date().toISOString().slice(0, 10)}.txt`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(url);
    });

})();
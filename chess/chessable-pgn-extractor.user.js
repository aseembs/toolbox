// ==UserScript==
// @name         Chessable PGN Exporter
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Intercepts and exports annotated PGNs (with FEN). Features auto-download, sequential file numbering, and auto-advancing.
// @author       Aseem Sharan
// @match        https://www.chessable.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // State variables
    let currentGameData = null;
    let isAutoDownload = true;

    // --- STORAGE FOR SEED AND COUNTER ---
    function getConfig() {
        return {
            seed: localStorage.getItem('chessable_dl_seed') || '1',
            counter: parseInt(localStorage.getItem('chessable_dl_counter') || '1', 10)
        };
    }

    function setConfig(seed, counter) {
        localStorage.setItem('chessable_dl_seed', seed);
        localStorage.setItem('chessable_dl_counter', counter.toString());

        const seedInput = document.getElementById('chessable-seed-input');
        const counterInput = document.getElementById('chessable-counter-input');
        if (seedInput) seedInput.value = seed;
        if (counterInput) counterInput.value = counter;
    }

    // --- NEW: FEN CHECKER ---
    function isStandardStartPosition(fen) {
        if (!fen) return true;
        const standardFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        const fenParts = fen.trim().split(/\s+/);
        const stdParts = standardFen.split(' ');
        return fenParts[0] === stdParts[0] && (fenParts[1] === undefined || fenParts[1] === stdParts[1]);
    }

    // --- PGN PARSING LOGIC (UPGRADED FEN v2) ---
    function extractCommentary(afterData) {
        if (!afterData || !afterData.data) return "";
        const comments = [];
        for (const item of afterData.data) {
            if (!item.val) continue;
            const val = item.val;
            const key = item.key || '';
            if (typeof val === 'string') {
                let commentText = val;
                commentText = commentText.replace(/@@SANStart@@(.*?)@@SANEnd@@/g, '$1');
                commentText = commentText.replace(/@@StartBracket@@(.*?)@@EndBracket@@/g, '$1');
                commentText = commentText.replace(/<br\s*\/?>/g, ' ');
                commentText = commentText.replace(/<strong>(.*?)<\/strong>/g, '$1');
                commentText = commentText.replace(/\s+/g, ' ').trim();
                comments.push(commentText);
            }
            else if (Array.isArray(val)) {
                const nestedParts = [];
                for (const nestedItem of val) {
                    const itemKey = nestedItem.key || '';
                    const itemVal = nestedItem.val || '';
                    if (itemKey === 'C') {
                        let text = itemVal.replace(/@@SANStart@@(.*?)@@SANEnd@@/g, '$1');
                        text = text.replace(/\s+/g, ' ').trim();
                        nestedParts.push(text);
                    } else if (itemKey === 'S') {
                        nestedParts.push(itemVal);
                    }
                }
                if (nestedParts.length > 0) comments.push(nestedParts.join(' '));
            }
        }
        return comments.join(' ');
    }

    function extractBeforeCommentary(move) {
        const beforeField = move.before || '';
        if (beforeField && typeof beforeField === 'string' && beforeField.startsWith('{')) {
            try {
                const beforeData = JSON.parse(beforeField);
                return extractCommentary(beforeData);
            } catch (e) {}
        }
        return "";
    }

    function convertToPGN(gameData) {
        const gameInfo = gameData.game || {};
        const moves = gameInfo.data || [];

        if (moves.length === 0) throw new Error("No moves found in game data");

        const tokens = [];
        let moveNum = 1;
        let whiteMove = "";
        let whiteAnnotation = "";
        let whiteAfterComment = "";

        for (const move of moves) {
            const san = move.san || '';
            const col = move.col || '';
            const ann1 = (move.ann1 || '').trim();
            const beforeComment = extractBeforeCommentary(move);
            let afterComment = "";
            const afterField = move.after || '';

            if (afterField && typeof afterField === 'string') {
                try {
                    const afterData = JSON.parse(afterField);
                    const commentText = extractCommentary(afterData);
                    if (commentText) afterComment = commentText;
                } catch (e) {}
            }

            if (col === 'w') {
                if (beforeComment) tokens.push(`{${beforeComment}}`);
                if (san) {
                    whiteMove = san;
                    whiteAnnotation = ann1;
                    whiteAfterComment = afterComment ? `{${afterComment}}` : "";
                } else {
                    whiteMove = "";
                    whiteAnnotation = "";
                    whiteAfterComment = "";
                }
            } else if (col === 'b') {
                if (whiteMove) {
                    tokens.push(`${moveNum}. ${whiteMove}${whiteAnnotation}`);
                    if (whiteAfterComment) tokens.push(whiteAfterComment);
                    if (beforeComment) tokens.push(`{${beforeComment}}`);
                    if (san) {
                        tokens.push(`${san}${ann1}`);
                        if (afterComment) tokens.push(`{${afterComment}}`);
                    }
                    moveNum++;
                    whiteMove = "";
                    whiteAnnotation = "";
                    whiteAfterComment = "";
                } else {
                    if (beforeComment) tokens.push(`{${beforeComment}}`);
                    if (san) {
                        tokens.push(`${moveNum}... ${san}${ann1}`);
                        if (afterComment) tokens.push(`{${afterComment}}`);
                        moveNum++;
                    }
                }
            }
        }

        if (whiteMove) {
            tokens.push(`${moveNum}. ${whiteMove}${whiteAnnotation}`);
            if (whiteAfterComment) tokens.push(whiteAfterComment);
        }

        const gameName = gameInfo.name || 'Chessable Course';
        const openingName = gameInfo.openName || '';
        const lineName = gameInfo.lineName || '';
        const title = gameInfo.title || '';
        const result = gameInfo.result || '*';
        const startingFen = gameInfo.initial || null;

        const today = new Date();
        const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;

        let pgnContent = `[Event "${gameName}"]\n`;
        pgnContent += `[Site "Chessable.com"]\n`;
        pgnContent += `[Date "${dateStr}"]\n`;
        pgnContent += `[Round "?"]\n`;
        pgnContent += `[White "${lineName}"]\n`;
        pgnContent += `[Black "${title}"]\n`;
        pgnContent += `[Result "${result}"]\n`;
        pgnContent += `[Opening "${openingName}"]\n`;

        if (startingFen && !isStandardStartPosition(startingFen)) {
            pgnContent += `[FEN "${startingFen}"]\n`;
            pgnContent += `[SetUp "1"]\n`;
        }

        pgnContent += `\n`;
        pgnContent += tokens.join(' ') + '\n';
        pgnContent += `${result}\n`;

        return pgnContent;
    }

    // --- UI & NOTIFICATIONS ---
    function showNotification(message, type = 'success') {
        const toast = document.createElement('div');
        toast.style.cssText = `position: fixed; top: 70px; right: 10px; z-index: 10001; padding: 12px 20px; background-color: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : '#ff9800'}; color: white; border-radius: 5px; font-size: 14px; font-weight: bold; box-shadow: 0 2px 5px rgba(0,0,0,0.3); animation: slideIn 0.3s ease-out;`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease-in forwards';
            setTimeout(() => document.body.removeChild(toast), 300);
        }, 3000);
    }

    function updateButtonStatus(hasData) {
        const button = document.getElementById('chessable-pgn-export-btn');
        if (!button) return;
        if (hasData) {
            button.style.backgroundColor = '#4CAF50';
            button.textContent = '📥 Download PGN';
        } else {
            button.style.backgroundColor = '#9E9E9E';
            button.textContent = '📥 No Data';
        }
    }

    function clickNextPage() {
        const nextButton = document.getElementById('variation-btn-next-variation');
        if (nextButton) {
            showNotification('Moving to Next Variation...', 'warning');
            setTimeout(() => nextButton.click(), 1000);
        } else {
            console.log("Auto-Next: Button not found.");
        }
    }

    // --- DOWNLOAD WORKFLOW (WITH AUTO-NUMBERING) ---
    function downloadPGN() {
        if (!currentGameData) {
            showNotification('No game data available.', 'error');
            return;
        }

        try {
            const config = getConfig();
            const pgn = convertToPGN(currentGameData);
            const gameInfo = currentGameData.game || {};
            const lineName = gameInfo.lineName || '';
            const title = gameInfo.title || 'game';

            let baseName = (lineName ? lineName + ' - ' : '') + title;
            let cleanName = baseName.replace(/^([0-9]+[a-zA-Z\s\.]*)\)\s*/, '');
            const filename = `${config.seed}.${config.counter}) ${cleanName}.pgn`;

            const blob = new Blob([pgn], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showNotification(`✓ Downloaded: ${filename}`, 'success');

            setConfig(config.seed, config.counter + 1);

            if (isAutoDownload) {
                setTimeout(clickNextPage, 1000);
            }

        } catch (error) {
            showNotification('Error generating PGN: ' + error.message, 'error');
        }
    }

    // --- NETWORK INTERCEPTION ---
    function handleGameCapture(data) {
        currentGameData = data;
        updateButtonStatus(true);

        if (isAutoDownload) {
            console.log("Chessable PGN Exporter: New game detected, auto-downloading...");
            setTimeout(downloadPGN, 500);
        } else {
            showNotification('Game data captured! Click button to download.', 'success');
        }
    }

    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        return originalFetch.apply(this, args).then(response => {
            const clonedResponse = response.clone();
            const url = args[0];

            if (typeof url === 'string' && url.includes('/api/v1/getGame')) {
                clonedResponse.json()
                    .then(data => handleGameCapture(data))
                    .catch(err => console.error("Error parsing fetch:", err));
            }
            return response;
        });
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._url = url;
        return originalOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            if (this._url && this._url.includes('/api/v1/getGame')) {
                try {
                    const data = JSON.parse(this.responseText);
                    handleGameCapture(data);
                } catch (e) {
                    console.error("Error parsing XHR:", e);
                }
            }
        });
        return originalSend.apply(this, args);
    };

    // --- UI INJECTION ---
    function toggleAutoDownload() {
        isAutoDownload = !isAutoDownload;
        const toggleBtn = document.getElementById('chessable-auto-dl-btn');
        if (isAutoDownload) {
            toggleBtn.textContent = '🔄 Auto: ON';
            toggleBtn.style.backgroundColor = '#007bff';
            showNotification('Auto-Download & Next Enabled', 'success');
        } else {
            toggleBtn.textContent = '🔄 Auto: OFF';
            toggleBtn.style.backgroundColor = '#dc3545';
            showNotification('Auto-Download & Next Disabled', 'success');
        }
    }

    function addButtons() {
        if (document.getElementById('chessable-pgn-export-btn')) return;

        const config = getConfig();
        const container = document.createElement('div');
        container.style.cssText = `position: fixed; top: 10px; right: 10px; z-index: 10000; display: flex; gap: 8px; align-items: center; background: rgba(255,255,255,0.9); padding: 5px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.2);`;

        const seedContainer = document.createElement('div');
        seedContainer.innerHTML = `<span style="font-size: 12px; font-weight: bold; color: #333; margin-right: 4px;">Seed:</span>`;
        const seedInput = document.createElement('input');
        seedInput.id = 'chessable-seed-input';
        seedInput.type = 'text';
        seedInput.value = config.seed;
        seedInput.style.cssText = `width: 40px; padding: 5px; border-radius: 4px; border: 1px solid #ccc; text-align: center; font-weight: bold;`;
        seedInput.addEventListener('change', (e) => {
            setConfig(e.target.value, 1);
            showNotification(`Seed set to ${e.target.value}. Counter reset to 1.`, 'success');
        });
        seedContainer.appendChild(seedInput);

        const counterContainer = document.createElement('div');
        counterContainer.innerHTML = `<span style="font-size: 12px; font-weight: bold; color: #333; margin-right: 4px;">Ct:</span>`;
        const counterInput = document.createElement('input');
        counterInput.id = 'chessable-counter-input';
        counterInput.type = 'number';
        counterInput.value = config.counter;
        counterInput.style.cssText = `width: 40px; padding: 5px; border-radius: 4px; border: 1px solid #ccc; text-align: center; font-weight: bold;`;
        counterInput.addEventListener('change', (e) => {
            setConfig(getConfig().seed, parseInt(e.target.value, 10));
        });
        counterContainer.appendChild(counterInput);

        const dlButton = document.createElement('button');
        dlButton.id = 'chessable-pgn-export-btn';
        dlButton.textContent = '📥 No Data';
        dlButton.style.cssText = `padding: 8px 12px; background-color: #9E9E9E; color: white; border: none; border-radius: 5px; font-size: 13px; font-weight: bold; cursor: pointer; transition: background-color 0.3s;`;
        dlButton.onclick = downloadPGN;

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'chessable-auto-dl-btn';
        toggleBtn.textContent = '🔄 Auto: ON';
        toggleBtn.style.cssText = `padding: 8px 12px; background-color: #007bff; color: white; border: none; border-radius: 5px; font-size: 13px; font-weight: bold; cursor: pointer; transition: background-color 0.3s;`;
        toggleBtn.onclick = toggleAutoDownload;

        container.appendChild(seedContainer);
        container.appendChild(counterContainer);
        container.appendChild(dlButton);
        container.appendChild(toggleBtn);
        document.body.appendChild(container);

        const style = document.createElement('style');
        style.textContent = `@keyframes slideIn { from { transform: translateX(400px); opacity: 0; } to { transform: translateX(0); opacity: 1; } } @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(400px); opacity: 0; } }`;
        document.head.appendChild(style);
    }

    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', addButtons);
        } else {
            addButtons();
        }
        setTimeout(addButtons, 2000);
        setTimeout(addButtons, 5000);
    }

    init();
})();

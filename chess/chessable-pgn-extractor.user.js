// ==UserScript==
// @name         Chessable PGN Exporter (with FEN v2)
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Export Chessable games to PGN format with all annotations, commentary, starting FEN, and correct comment placement
// @author       Your Name
// @match        https://www.chessable.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    let currentGameData = null;

    /**
     * Extract commentary from nested data structure
     */
    function extractCommentary(afterData) {
        if (!afterData || !afterData.data) {
            return "";
        }

        const comments = [];
        for (const item of afterData.data) {
            if (!item.val) continue;

            const val = item.val;
            const key = item.key || '';

            // If val is a string, it's a comment
            if (typeof val === 'string') {
                let commentText = val;
                // Clean up Chessable-specific markers
                commentText = commentText.replace(/@@SANStart@@(.*?)@@SANEnd@@/g, '$1');
                commentText = commentText.replace(/@@StartBracket@@(.*?)@@EndBracket@@/g, '$1');
                // Remove HTML tags
                commentText = commentText.replace(/<br\s*\/?>/g, ' ');
                commentText = commentText.replace(/<strong>(.*?)<\/strong>/g, '$1');
                // Clean up extra whitespace
                commentText = commentText.replace(/\s+/g, ' ').trim();
                comments.push(commentText);
            }
            // If val is an array, it contains nested commentary (like variations)
            else if (Array.isArray(val)) {
                const nestedParts = [];
                for (const nestedItem of val) {
                    const itemKey = nestedItem.key || '';
                    const itemVal = nestedItem.val || '';

                    if (itemKey === 'C') {  // Comment
                        let text = itemVal.replace(/@@SANStart@@(.*?)@@SANEnd@@/g, '$1');
                        text = text.replace(/\s+/g, ' ').trim();
                        nestedParts.push(text);
                    } else if (itemKey === 'S') {  // Chess move
                        nestedParts.push(itemVal);
                    }
                }
                if (nestedParts.length > 0) {
                    comments.push(nestedParts.join(' '));
                }
            }
        }

        return comments.join(' ');
    }

    /**
     * Extract commentary from 'before' field if it exists
     */
    function extractBeforeCommentary(move) {
        const beforeField = move.before || '';
        if (beforeField && typeof beforeField === 'string' && beforeField.startsWith('{')) {
            try {
                const beforeData = JSON.parse(beforeField);
                return extractCommentary(beforeData);
            } catch (e) {
                // Ignore parse errors
            }
        }
        return "";
    }

    /**
     * Check if a FEN string represents the standard starting position
     */
    function isStandardStartPosition(fen) {
        if (!fen) return true;
        const standardFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        const fenParts = fen.trim().split(/\s+/);
        const stdParts = standardFen.split(' ');
        return fenParts[0] === stdParts[0] && (fenParts[1] === undefined || fenParts[1] === stdParts[1]);
    }

    /**
     * Convert game data to PGN format
     */
    function convertToPGN(gameData) {
        const gameInfo = gameData.game || {};
        const moves = gameInfo.data || [];

        if (moves.length === 0) {
            throw new Error("No moves found in game data");
        }

        // Build PGN tokens — each entry is a string fragment that will be joined with spaces
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
                    if (commentText) {
                        afterComment = commentText;
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            }

            if (col === 'w') {
                // A comment that appears before white's move belongs BEFORE the move number.
                // Emit it as a standalone token now, before we emit the move number + move.
                if (beforeComment) {
                    tokens.push(`{${beforeComment}}`);
                }

                if (san) {
                    // Normal white move
                    whiteMove = san;
                    whiteAnnotation = ann1;
                    whiteAfterComment = afterComment ? `{${afterComment}}` : "";
                } else {
                    // No move, comment only — already pushed above; nothing more to store
                    whiteMove = "";
                    whiteAnnotation = "";
                    whiteAfterComment = "";
                }

            } else if (col === 'b') {
                if (whiteMove) {
                    // Emit the white half of the pair: "N. move[ann] [afterComment]"
                    tokens.push(`${moveNum}. ${whiteMove}${whiteAnnotation}`);
                    if (whiteAfterComment) tokens.push(whiteAfterComment);

                    // Black's before-comment comes after white's after-comment, before black's move
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
                    // White had no move (comment-only white slot) — black starts the move pair
                    // In this case the move number needs an ellipsis for black
                    if (beforeComment) tokens.push(`{${beforeComment}}`);
                    if (san) {
                        tokens.push(`${moveNum}... ${san}${ann1}`);
                        if (afterComment) tokens.push(`{${afterComment}}`);
                        moveNum++;
                    }
                }
            }
        }

        // Handle case where last move is white
        if (whiteMove) {
            tokens.push(`${moveNum}. ${whiteMove}${whiteAnnotation}`);
            if (whiteAfterComment) tokens.push(whiteAfterComment);
        }

        // Get additional game info
        const gameName = gameInfo.name || 'Chessable Course';
        const openingName = gameInfo.openName || '';
        const lineName = gameInfo.lineName || '';
        const title = gameInfo.title || '';
        const result = gameInfo.result || '*';
        const color = gameInfo.color || '';

        // Determine player colors
        let whitePlayer = "?";
        let blackPlayer = "?";
        if (color === 'w') {
            whitePlayer = "Student";
            blackPlayer = "Opponent";
        } else if (color === 'b') {
            whitePlayer = "Opponent";
            blackPlayer = "Student";
        }

        // Get current date
        const today = new Date();
        const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;

        // Get starting FEN position
        const startingFen = gameInfo.initial || null;

        // Create PGN headers
        let pgnContent = `[Event "${gameName}"]\n`;
        pgnContent += `[Site "Chessable.com"]\n`;
        pgnContent += `[Date "${dateStr}"]\n`;
        pgnContent += `[Round "?"]\n`;
        pgnContent += `[White "${lineName}"]\n`;
        pgnContent += `[Black "${title}"]\n`;
        pgnContent += `[Result "${result}"]\n`;
        pgnContent += `[Opening "${openingName}"]\n`;
        //pgnContent += `[Variation "${lineName} - ${title}"]\n`;

        // Add FEN tag only when the starting position is not the standard one
        if (startingFen && !isStandardStartPosition(startingFen)) {
            pgnContent += `[FEN "${startingFen}"]\n`;
            pgnContent += `[SetUp "1"]\n`;
        }

        pgnContent += `\n`;

        // Join all tokens with spaces and append result
        pgnContent += tokens.join(' ') + '\n';
        pgnContent += `${result}\n`;

        return pgnContent;
    }

    /**
     * Show notification toast
     */
    function showNotification(message, type = 'success') {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 70px;
            right: 10px;
            z-index: 10001;
            padding: 12px 20px;
            background-color: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : '#ff9800'};
            color: white;
            border-radius: 5px;
            font-size: 14px;
            font-weight: bold;
            box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            animation: slideIn 0.3s ease-out;
        `;
        toast.textContent = message;

        // Add animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(400px); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(400px); opacity: 0; }
            }
        `;
        document.head.appendChild(style);

        document.body.appendChild(toast);

        // Remove after 3 seconds
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease-in';
            setTimeout(() => {
                document.body.removeChild(toast);
            }, 300);
        }, 3000);
    }

    /**
     * Update button status
     */
    function updateButtonStatus(hasData) {
        const button = document.getElementById('chessable-pgn-export-btn');
        if (!button) return;

        if (hasData) {
            button.style.backgroundColor = '#4CAF50';
            button.textContent = '📥 Download PGN';
            button.title = 'Click to download the current position as PGN';
        } else {
            button.style.backgroundColor = '#9E9E9E';
            button.textContent = '📥 No Data';
            button.title = 'Navigate to a game position first';
        }
    }

    /**
     * Download PGN file
     */
    function downloadPGN() {
        if (!currentGameData) {
            showNotification('No game data available. Navigate to a position first.', 'error');
            return;
        }

        try {
            const button = document.getElementById('chessable-pgn-export-btn');
            if (button) {
                button.textContent = '⏳ Generating...';
            }

            const pgn = convertToPGN(currentGameData);

            // Create filename from game info
            const gameInfo = currentGameData.game || {};
            const lineName = gameInfo.lineName || 'game';
            const title = gameInfo.title || 'game';
            //const filename = lineName.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.pgn';
            const filename = lineName + ' - ' + title + '.pgn';
            //const filename = title + '.pgn';

            // Create blob and download
            const blob = new Blob([pgn], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log("PGN downloaded successfully!");
            showNotification(`✓ Downloaded: ${filename}`, 'success');

            if (button) {
                button.textContent = '📥 Download PGN';
            }
        } catch (error) {
            showNotification('Error generating PGN: ' + error.message, 'error');
            console.error("Error generating PGN:", error);

            const button = document.getElementById('chessable-pgn-export-btn');
            if (button) {
                button.textContent = '📥 Download PGN';
            }
        }
    }

    /**
     * Intercept fetch requests to capture game data
     */
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        return originalFetch.apply(this, args).then(response => {
            const clonedResponse = response.clone();

            const url = args[0];
            if (typeof url === 'string' && url.includes('/api/v1/getGame')) {
                clonedResponse.json().then(data => {
                    console.log("Captured Chessable game data");
                    currentGameData = data;
                    updateButtonStatus(true);
                    showNotification('Game data captured! Click button to download.', 'success');
                }).catch(err => {
                    console.error("Error parsing game data:", err);
                });
            }

            return response;
        });
    };

    /**
     * Intercept XMLHttpRequest to capture game data
     */
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
                    console.log("Captured Chessable game data (XHR)");
                    currentGameData = data;
                    updateButtonStatus(true);
                    showNotification('Game data captured! Click button to download.', 'success');
                } catch (e) {
                    console.error("Error parsing game data:", e);
                }
            }
        });
        return originalSend.apply(this, args);
    };

    /**
     * Add download button to the page
     */
    function addDownloadButton() {
        if (document.getElementById('chessable-pgn-export-btn')) {
            return;
        }

        const button = document.createElement('button');
        button.id = 'chessable-pgn-export-btn';
        button.textContent = '📥 Download PGN';
        button.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            z-index: 10000;
            padding: 10px 15px;
            background-color: #4CAF50;
            color: white;
            border: none;
            border-radius: 5px;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            transition: background-color 0.3s;
        `;

        button.onmouseover = function() {
            this.style.backgroundColor = '#45a049';
        };

        button.onmouseout = function() {
            this.style.backgroundColor = '#4CAF50';
        };

        button.onclick = downloadPGN;

        document.body.appendChild(button);
        console.log("Chessable PGN Exporter: Download button added");
    }

    /**
     * Initialize the script
     */
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', addDownloadButton);
        } else {
            addDownloadButton();
        }

        setTimeout(addDownloadButton, 2000);
        setTimeout(addDownloadButton, 5000);
    }

    init();

    console.log("Chessable PGN Exporter loaded successfully!");
})();

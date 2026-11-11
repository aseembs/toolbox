// ==UserScript==
// @name         ChessNeurons Puzzle PGN Decryptor
// @namespace    chessneurons-pgn-decryptor
// @version      1.0
// @description  Passively captures ChessNeurons' own puzzle fetches (easy + hard), decrypts their PGNs, and shows them in an overlay panel.
// @match        https://chessneurons.com/*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const LOG_PREFIX = '[ChessNeurons PGN Decryptor]';
  const LOG = (...args) => console.log(LOG_PREFIX, ...args);
  const LOG_ERR = (...args) => console.error(LOG_PREFIX, ...args);

  LOG('script top-level execution started, readyState =', document.readyState);

  // ---- Decryption (port of decrypt_puzzles_grouped.py) ----

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function decryptPuzzle(puzzleId, activeDate, encryptedPgn) {
    // Remove milliseconds from date (keep only YYYY-MM-DDTHH:MM:SSZ format)
    const dateWithoutMs = activeDate.includes('.000Z')
      ? activeDate.replace('.000Z', 'Z')
      : activeDate;

    const xorKey = puzzleId + dateWithoutMs;
    const keyBytes = new TextEncoder().encode(xorKey);

    let encryptedBytes;
    try {
      encryptedBytes = base64ToBytes(encryptedPgn);
    } catch (e) {
      return `Error decoding base64: ${e}`;
    }

    const decryptedBytes = new Uint8Array(encryptedBytes.length);
    for (let i = 0; i < encryptedBytes.length; i++) {
      decryptedBytes[i] = encryptedBytes[i] ^ keyBytes[i % keyBytes.length];
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(decryptedBytes);
    } catch (e) {
      return 'Error: Unable to decode decrypted bytes to UTF-8';
    }
  }

  // ---- Networking ----
  // No active fetch: this script only listens passively to the page's own
  // fetchpuzzles calls and decrypts whatever it observes.

  // ---- Passive interception of the page's own fetchpuzzles calls ----
  // Captures puzzles the page already fetched for its own board rendering,
  // so we don't fire redundant network requests when the page loads them itself.
  const capturedPuzzles = { EASY: null, HARD: null };
  const captureListeners = [];

  function notifyCapture() {
    captureListeners.forEach((cb) => cb());
  }

  function tryCapture(requestBody, responseText) {
    try {
      const reqJson = JSON.parse(requestBody);
      const difficultyType = reqJson && reqJson.difficultyType;
      if (difficultyType !== 'EASY' && difficultyType !== 'HARD') {
        LOG('tryCapture: not a fetchpuzzles EASY/HARD request body, ignoring');
        return;
      }

      const resJson = JSON.parse(responseText);
      if (!resJson || !Array.isArray(resJson.Puzzles)) {
        LOG('tryCapture: response JSON missing Puzzles array, ignoring', resJson);
        return;
      }

      capturedPuzzles[difficultyType] = resJson.Puzzles;
      LOG(`tryCapture: captured ${resJson.Puzzles.length} ${difficultyType} puzzles from page's own request`);
      notifyCapture();
    } catch (e) {
      LOG('tryCapture: not JSON or unexpected shape, ignoring', e);
    }
  }

  function installInterceptors() {
    // Tampermonkey runs userscripts in a sandboxed context whose `window` is
    // NOT the page's real window in default/sandboxed injection modes.
    // Patching bare `window.fetch` there only patches our sandbox's copy —
    // the page's own bundled JS keeps calling the real, unpatched fetch, so
    // we'd never observe its calls. `unsafeWindow` is Tampermonkey/Greasemonkey's
    // explicit handle to the actual page window; fall back to `window` for
    // engines that don't sandbox (e.g. some Greasemonkey/Violentmonkey modes
    // where window already *is* the page window and unsafeWindow is undefined).
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    LOG('installInterceptors: patching fetch and XMLHttpRequest on', typeof unsafeWindow !== 'undefined' ? 'unsafeWindow (page window)' : 'window (no unsafeWindow available)');

    // Patch fetch
    const originalFetch = pageWindow.fetch;
    pageWindow.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url);
      const isTarget = url && url.indexOf('fetchpuzzles') !== -1;
      if (isTarget) LOG('fetch() intercepted call to fetchpuzzles:', url);
      const promise = originalFetch.apply(this, arguments);
      if (isTarget) {
        promise
          .then((res) => res.clone().text().then((text) => {
            const body = (init && init.body) || '';
            tryCapture(body, text);
          }))
          .catch((e) => LOG('fetch interceptor: error reading response clone', e));
      }
      return promise;
    };

    // Patch XMLHttpRequest
    const OriginalXHR = pageWindow.XMLHttpRequest;
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url) {
      this._cnIsTarget = typeof url === 'string' && url.indexOf('fetchpuzzles') !== -1;
      if (this._cnIsTarget) LOG('XHR.open() intercepted call to fetchpuzzles:', url);
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function (body) {
      if (this._cnIsTarget) {
        this.addEventListener('load', () => {
          tryCapture(body || '', this.responseText);
        });
      }
      return originalSend.apply(this, arguments);
    };

    LOG('installInterceptors: done, fetch/XHR patched successfully');
  }

  // Install as early as possible so we don't miss the page's initial calls.
  // Wrapped so a sandbox/CSP quirk here can't silently abort the whole
  // script and prevent the toggle button from ever being created below.
  try {
    installInterceptors();
  } catch (e) {
    LOG_ERR('installInterceptors failed — network capture disabled, but continuing:', e);
  }


  // ---- UI ----

  const CN_STYLES = `
    #cn-pgn-panel {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 420px;
      max-height: 85vh;
      overflow-y: auto;
      background: #1e1e1e;
      color: #eee;
      font-family: monospace;
      font-size: 12px;
      border: 1px solid #444;
      border-radius: 8px;
      z-index: 999999;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    }
    #cn-pgn-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: #2a2a2a;
      border-bottom: 1px solid #444;
      cursor: move;
      border-radius: 8px 8px 0 0;
    }
    #cn-pgn-panel-header b { font-size: 13px; }
    #cn-pgn-panel-body { padding: 10px 12px; }
    #cn-pgn-panel button {
      background: #3a3a3a;
      color: #eee;
      border: 1px solid #555;
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 11px;
      margin-left: 4px;
    }
    #cn-pgn-panel button:hover { background: #4a4a4a; }
    .cn-puzzle-block {
      border-bottom: 1px solid #333;
      padding: 8px 0;
    }
    .cn-puzzle-block:last-child { border-bottom: none; }
    .cn-puzzle-title { color: #7fd0ff; margin-bottom: 4px; }
    .cn-puzzle-tags { color: #999; font-size: 10px; margin-bottom: 4px; }
    .cn-pgn-text {
      white-space: pre-wrap;
      word-break: break-word;
      background: #111;
      padding: 6px;
      border-radius: 4px;
      user-select: text;
    }
    .cn-section-title {
      margin: 10px 0 4px;
      color: #ffd27f;
      font-weight: bold;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .cn-section-toggle {
      cursor: pointer;
      user-select: none;
    }
    .cn-caret {
      display: inline-block;
      width: 10px;
    }
    .cn-section-body {
      margin-bottom: 4px;
    }
    .cn-section-title .cn-copy-btn,
    .cn-section-title .cn-download-btn {
      font-weight: normal;
      font-size: 11px;
      padding: 3px 8px;
      background: #3a3a3a;
      color: #eee;
      border: 1px solid #555;
      border-radius: 4px;
      cursor: pointer;
      margin-left: 4px;
    }
    .cn-section-title .cn-copy-btn:hover,
    .cn-section-title .cn-download-btn:hover {
      background: #4a4a4a;
    }
    .cn-section-title .cn-copy-btn:disabled,
    .cn-section-title .cn-download-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #cn-pgn-toggle {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 999998;
      background: #3a3a3a;
      color: #eee;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 8px 12px;
      cursor: pointer;
      font-family: monospace;
      font-size: 12px;
    }
    .cn-status-line {
      color: #999;
      margin-bottom: 8px;
    }
    .cn-status-line.cn-status-ok { color: #8f8; }
    .cn-status-line.cn-status-waiting { color: #ffd27f; }
    #cn-pgn-toggle:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  function injectStyles() {
    LOG('injectStyles: injecting CSS...');
    try {
      GM_addStyle(CN_STYLES);
      LOG('injectStyles: GM_addStyle succeeded');
    } catch (e) {
      LOG_ERR('injectStyles: GM_addStyle threw, falling back to manual <style> tag', e);
      const style = document.createElement('style');
      style.textContent = CN_STYLES;
      (document.head || document.documentElement).appendChild(style);
      LOG('injectStyles: manual <style> tag appended');
    }
  }

  function renderPuzzle(puzzle) {
    const decrypted = decryptPuzzle(puzzle.id, puzzle.activeDate, puzzle.pgn);
    const tags = (puzzle.tags || []).join(', ');
    return `
      <div class="cn-puzzle-block">
        <div class="cn-puzzle-title">#${puzzle.name} (difficulty ${puzzle.difficulty}) — ${puzzle.fen || ''}</div>
        <div class="cn-puzzle-tags">${tags}</div>
        <div class="cn-pgn-text">${decrypted.replace(/</g, '&lt;')}</div>
      </div>
    `;
  }

  function renderPuzzleSections(easyList, hardList, collapsedState) {
    const sortByName = (a, b) => parseInt(a.name, 10) - parseInt(b.name, 10);
    const easy = [...easyList].sort(sortByName);
    const hard = [...hardList].sort(sortByName);

    const header = (title, key, list) => `
      <div class="cn-section-title">
        <span class="cn-section-toggle" data-toggle-key="${key}">
          <span class="cn-caret">${collapsedState[key] ? '▸' : '▾'}</span> ${title} (${list.length})
        </span>
        <span>
          <button class="cn-copy-btn" data-key="${key}" ${list.length ? '' : 'disabled'}>Copy</button>
          <button class="cn-download-btn" data-key="${key}" ${list.length ? '' : 'disabled'}>Download</button>
        </span>
      </div>
    `;

    const body = (key, list) => `
      <div class="cn-section-body" data-body-key="${key}" ${collapsedState[key] ? 'style="display:none"' : ''}>
        ${list.length ? list.map(renderPuzzle).join('') : '<div class="cn-puzzle-tags">Not captured yet.</div>'}
      </div>
    `;

    return (
      header('EASY', 'EASY', easy) +
      header('HARD', 'HARD', hard) +
      body('EASY', easy) +
      body('HARD', hard)
    );
  }

  // Lichess studies only recognize standard PGN tags — [ChapterName "..."]
  // drives the sidebar chapter title, [Event] is shown as game info, and
  // WhiteElo/BlackElo render as a rating badge — so puzzle metadata is
  // folded into those rather than custom tags Lichess would drop on import.
  function setPgnTag(pgnText, tagName, value) {
    const escaped = String(value).replace(/"/g, '\\"');
    const tagRe = new RegExp(`\\[${tagName}\\s+"[^"]*"\\]`);
    if (tagRe.test(pgnText)) {
      return pgnText.replace(tagRe, `[${tagName} "${escaped}"]`);
    }
    const newTag = `[${tagName} "${escaped}"]`;
    const lastTagEnd = pgnText.lastIndexOf(']');
    if (lastTagEnd === -1) {
      return `${newTag} ${pgnText}`;
    }
    return `${pgnText.slice(0, lastTagEnd + 1)} ${newTag}${pgnText.slice(lastTagEnd + 1)}`;
  }

  function addPuzzleTags(pgnText, puzzle, difficultyType) {
    const dateOnly = (puzzle.activeDate || '').slice(0, 10);
    const chapterName = `${dateOnly} #${puzzle.name}`;
    const themeSuffix = puzzle.tags && puzzle.tags.length ? ` - ${puzzle.tags.join(', ')}` : '';
    const eventName = `${difficultyType === 'HARD' ? 'Hard' : 'Easy'}${themeSuffix}`;

    let result = pgnText;
    result = setPgnTag(result, 'ChapterName', chapterName);
    result = setPgnTag(result, 'Event', eventName);
    result = setPgnTag(result, 'WhiteElo', puzzle.difficulty);
    result = setPgnTag(result, 'BlackElo', puzzle.difficulty);
    return result;
  }

  // Reformats a single-line "[Tag "v"] [Tag "v"] ... 1. e4 e5 *" PGN into the
  // conventional pretty-printed layout: one tag pair per line, a blank line,
  // then the movetext — purely cosmetic, doesn't change PGN validity.
  function prettyPrintPgn(pgnText) {
    const tagRe = /\[[A-Za-z0-9_]+\s+"(?:[^"\\]|\\.)*"\]/g;
    const tags = pgnText.match(tagRe) || [];
    const movetext = pgnText.replace(tagRe, '').trim();
    return tags.join('\n') + (movetext ? `\n\n${movetext}` : '');
  }

  function puzzlesToPgn(list, difficultyType) {
    const sortByName = (a, b) => parseInt(a.name, 10) - parseInt(b.name, 10);
    const sorted = [...list].sort(sortByName);
    return sorted
      .map((p) => prettyPrintPgn(addPuzzleTags(decryptPuzzle(p.id, p.activeDate, p.pgn), p, difficultyType)))
      .join('\n\n\n');
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sectionCollapsed = { EASY: true, HARD: true };

  function renderPanelBody(body) {
    const easy = capturedPuzzles.EASY;
    const hard = capturedPuzzles.HARD;
    const haveEasy = Array.isArray(easy);
    const haveHard = Array.isArray(hard);

    let statusHtml;
    if (haveEasy && haveHard) {
      statusHtml = '<div class="cn-status-line cn-status-ok">Captured from the page\'s own request.</div>';
    } else {
      statusHtml = '<div class="cn-status-line cn-status-waiting">Waiting for the page to call fetchpuzzles… (happens automatically on page load — no action needed)</div>';
    }

    body.innerHTML = statusHtml + renderPuzzleSections(easy || [], hard || [], sectionCollapsed);

    // innerHTML replacement wipes any previously attached listeners, so
    // (re-)wire the per-section Copy/Download/collapse controls every render.
    body.querySelectorAll('.cn-copy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const list = capturedPuzzles[btn.dataset.key] || [];
        navigator.clipboard.writeText(puzzlesToPgn(list, btn.dataset.key))
          .then(() => LOG(`Copy (${btn.dataset.key}): copied to clipboard`))
          .catch((e) => LOG_ERR(`Copy (${btn.dataset.key}): failed`, e));
      });
    });
    body.querySelectorAll('.cn-download-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const list = capturedPuzzles[btn.dataset.key] || [];
        downloadText(`chessneurons-${btn.dataset.key.toLowerCase()}.pgn`, puzzlesToPgn(list, btn.dataset.key));
      });
    });
    body.querySelectorAll('.cn-section-toggle').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.dataset.toggleKey;
        sectionCollapsed[key] = !sectionCollapsed[key];
        renderPanelBody(body);
      });
    });
  }

  function makeDraggable(panel, handle) {
    let offsetX = 0, offsetY = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      offsetX = e.clientX - panel.offsetLeft;
      offsetY = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = `${e.clientX - offsetX}px`;
      panel.style.top = `${e.clientY - offsetY}px`;
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function buildPanel() {
    LOG('buildPanel: creating panel element');
    const panel = document.createElement('div');
    panel.id = 'cn-pgn-panel';
    panel.innerHTML = `
      <div id="cn-pgn-panel-header">
        <b>ChessNeurons PGNs</b>
        <div>
          <button id="cn-pgn-close">Close</button>
        </div>
      </div>
      <div id="cn-pgn-panel-body"></div>
    `;
    document.body.appendChild(panel);
    LOG('buildPanel: panel appended to document.body');

    const header = panel.querySelector('#cn-pgn-panel-header');
    const body = panel.querySelector('#cn-pgn-panel-body');
    makeDraggable(panel, header);

    // Live-update the panel whenever passive capture picks up new data,
    // without ever firing a request ourselves.
    const onCapture = () => renderPanelBody(body);
    captureListeners.push(onCapture);

    panel.querySelector('#cn-pgn-close').addEventListener('click', () => {
      const idx = captureListeners.indexOf(onCapture);
      if (idx !== -1) captureListeners.splice(idx, 1);
      panel.remove();
      showToggleButton();
    });

    renderPanelBody(body);
  }

  function showToggleButton() {
    let btn = document.getElementById('cn-pgn-toggle');
    if (btn) {
      LOG('showToggleButton: button already exists, skipping creation');
      return;
    }
    LOG('showToggleButton: creating toggle button');
    btn = document.createElement('button');
    btn.id = 'cn-pgn-toggle';
    updateToggleButtonState(btn);
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      btn.remove();
      buildPanel();
    });
    document.body.appendChild(btn);
    LOG('showToggleButton: button appended to document.body — should be visible now');
  }

  function updateToggleButtonState(btn) {
    const captured = Array.isArray(capturedPuzzles.EASY) && Array.isArray(capturedPuzzles.HARD);
    btn.disabled = !captured;
    btn.textContent = captured
      ? 'Show Decrypted PGNs'
      : 'Waiting for puzzles…';
  }

  // Keep the toggle button's enabled/disabled state in sync with capture,
  // even if the button was created before capture completed.
  captureListeners.push(() => {
    const btn = document.getElementById('cn-pgn-toggle');
    if (btn) updateToggleButtonState(btn);
  });

  function init() {
    LOG('init: called, document.body exists =', !!document.body);
    try {
      if (!document.body) {
        LOG('init: document.body not ready yet, will retry on next trigger');
        return false;
      }
      injectStyles();
      showToggleButton();
      LOG('init: completed successfully');
      return true;
    } catch (e) {
      LOG_ERR('init: threw an error', e);
      return false;
    }
  }

  LOG('reached end of setup, readyState =', document.readyState);

  // Belt-and-suspenders startup: React SPAs and userscript sandboxes make
  // it hard to guarantee any single lifecycle event fires after this script
  // attaches its listener, so try every trigger and also poll as a backstop.
  document.addEventListener('DOMContentLoaded', () => {
    LOG('DOMContentLoaded fired');
    init();
  });
  window.addEventListener('load', () => {
    LOG('window load fired');
    init();
  });

  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    LOG('readyState already interactive/complete at script run time, calling init() immediately');
    init();
  }

  let pollCount = 0;
  const pollId = setInterval(() => {
    pollCount++;
    LOG(`poll #${pollCount}: checking if button exists yet`);
    if (init()) {
      LOG('poll: init succeeded, stopping poll');
      clearInterval(pollId);
    }
  }, 500);
  setTimeout(() => {
    clearInterval(pollId);
    LOG('poll: stopped after 20s timeout');
  }, 20000);
})();

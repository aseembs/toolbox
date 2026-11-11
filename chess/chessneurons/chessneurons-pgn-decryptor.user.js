// ==UserScript==
// @name         ChessNeurons Puzzle PGN Decryptor
// @namespace    chessneurons-pgn-decryptor
// @version      1.1
// @description  Passively captures ChessNeurons' puzzle fetches (daily batches and individual history), decrypts their PGNs, and shows them in an overlay panel.
// @author       Aseem Sharan
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

  // ---- Decryption (unchanged from the original script) ----

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

  // ---- Passive networking capture ----
  // This script never sends a fetch/XHR of its own. It only observes requests
  // that the ChessNeurons page itself makes.
  //
  // Daily fetchpuzzles calls contain the ID in each response puzzle.
  // Individual /puzzle calls contain the ID in the outgoing request body, while
  // the response puzzle.id is blank. We restore that request ID before decrypting.

  const capturedPuzzles = {
    EASY: null,
    HARD: null,
    OPENED: []
  };

  const captureListeners = [];

  function notifyCapture() {
    captureListeners.forEach((cb) => cb());
  }

  function getCaptureKind(url) {
    if (!url) return null;

    let pathname;
    try {
      pathname = new URL(String(url), window.location.href).pathname;
    } catch (e) {
      pathname = String(url).split('?')[0];
    }

    const normalized = pathname.replace(/\/+$/, '').toLowerCase();
    if (normalized.endsWith('/api/playersapi/fetchpuzzles')) return 'FETCH_PUZZLES';
    if (normalized.endsWith('/api/playersapi/puzzle')) return 'SINGLE_PUZZLE';
    return null;
  }

  function getRequestUrl(input) {
    return typeof input === 'string' ? input : (input && input.url);
  }

  function readFetchRequestBody(input, init) {
    if (init && init.body != null) {
      if (typeof init.body === 'string') return Promise.resolve(init.body);
      if (typeof init.body.text === 'function') {
        return init.body.text().catch(() => String(init.body));
      }
      return Promise.resolve(String(init.body));
    }

    if (input && typeof input !== 'string' && typeof input.clone === 'function') {
      try {
        return input.clone().text().catch(() => '');
      } catch (e) {
        return Promise.resolve('');
      }
    }

    return Promise.resolve('');
  }

  function resolvePuzzleDifficultyType(puzzle) {
    // This is the same Easy/Hard split used by the ChessNeurons frontend.
    const difficulty = Number(puzzle && puzzle.difficulty);
    if (Number.isFinite(difficulty)) {
      return difficulty < 1600 ? 'EASY' : 'HARD';
    }

    // Fallback only for malformed/missing difficulty values.
    const puzzleNumber = Number.parseInt(puzzle && puzzle.name, 10);
    return Number.isFinite(puzzleNumber) && puzzleNumber >= 6 ? 'HARD' : 'EASY';
  }

  function storeOpenedPuzzle(puzzle) {
    const existingIndex = capturedPuzzles.OPENED.findIndex(
      (item) => item.id === puzzle.id && item.activeDate === puzzle.activeDate
    );

    if (existingIndex === -1) {
      capturedPuzzles.OPENED.push(puzzle);
      LOG(`storeOpenedPuzzle: added #${puzzle.name || '?'} (${puzzle.id})`);
    } else {
      capturedPuzzles.OPENED[existingIndex] = puzzle;
      LOG(`storeOpenedPuzzle: refreshed existing #${puzzle.name || '?'} (${puzzle.id})`);
    }
  }

  function tryCaptureFetchPuzzles(requestBody, responseText) {
    try {
      const reqJson = JSON.parse(requestBody);
      const difficultyType = reqJson && reqJson.difficultyType;
      if (difficultyType !== 'EASY' && difficultyType !== 'HARD') {
        LOG('tryCaptureFetchPuzzles: request body is not EASY/HARD, ignoring');
        return;
      }

      const resJson = JSON.parse(responseText);
      if (!resJson || !Array.isArray(resJson.Puzzles)) {
        LOG('tryCaptureFetchPuzzles: response JSON missing Puzzles array, ignoring', resJson);
        return;
      }

      capturedPuzzles[difficultyType] = resJson.Puzzles;
      LOG(`tryCaptureFetchPuzzles: captured ${resJson.Puzzles.length} ${difficultyType} puzzles`);
      notifyCapture();
    } catch (e) {
      LOG('tryCaptureFetchPuzzles: not JSON or unexpected shape, ignoring', e);
    }
  }

  function tryCaptureSinglePuzzle(requestBody, responseText) {
    try {
      const reqJson = JSON.parse(requestBody);
      const puzzleId = reqJson && reqJson.id;
      if (typeof puzzleId !== 'string' || !puzzleId) {
        LOG('tryCaptureSinglePuzzle: request body missing id, ignoring');
        return;
      }

      const resJson = JSON.parse(responseText);
      const responsePuzzle = resJson && resJson.puzzle;
      if (!responsePuzzle || !responsePuzzle.pgn || !responsePuzzle.activeDate) {
        LOG('tryCaptureSinglePuzzle: response JSON missing puzzle/pgn/activeDate, ignoring', resJson);
        return;
      }

      // The /puzzle response intentionally returns id: "". The page itself
      // decrypts with the original request argument; do the same here.
      const puzzle = {
        ...responsePuzzle,
        id: puzzleId,
        _difficultyType: resolvePuzzleDifficultyType(responsePuzzle),
        _captureSource: 'SINGLE_PUZZLE'
      };

      storeOpenedPuzzle(puzzle);
      LOG(`tryCaptureSinglePuzzle: passively captured #${puzzle.name || '?'} (${puzzleId})`);
      notifyCapture();
    } catch (e) {
      LOG('tryCaptureSinglePuzzle: not JSON or unexpected shape, ignoring', e);
    }
  }

  function handleCapturedResponse(kind, requestBody, responseText) {
    if (kind === 'FETCH_PUZZLES') {
      tryCaptureFetchPuzzles(requestBody, responseText);
    } else if (kind === 'SINGLE_PUZZLE') {
      tryCaptureSinglePuzzle(requestBody, responseText);
    }
  }

  function installInterceptors() {
    // Tampermonkey runs userscripts in a sandboxed context whose `window` is
    // not necessarily the page's real window. unsafeWindow gives access to the
    // window used by ChessNeurons' bundled frontend.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    LOG(
      'installInterceptors: patching fetch and XMLHttpRequest on',
      typeof unsafeWindow !== 'undefined' ? 'unsafeWindow (page window)' : 'window'
    );

    // Patch fetch passively.
    const originalFetch = pageWindow.fetch;
    if (typeof originalFetch === 'function') {
      pageWindow.fetch = function (input, init) {
        const url = getRequestUrl(input);
        const kind = getCaptureKind(url);
        const requestBodyPromise = kind ? readFetchRequestBody(input, init) : null;

        if (kind) LOG(`fetch() intercepted ${kind}:`, url);

        // This is the page's original request. No extra request is sent.
        const promise = originalFetch.apply(this, arguments);

        if (kind) {
          promise
            .then((res) => Promise.all([
              requestBodyPromise,
              res.clone().text()
            ]))
            .then(([requestBody, responseText]) => {
              handleCapturedResponse(kind, requestBody || '', responseText);
            })
            .catch((e) => LOG('fetch interceptor: error reading captured request/response', e));
        }

        return promise;
      };
    }

    // Patch XMLHttpRequest as a fallback, also passively.
    const OriginalXHR = pageWindow.XMLHttpRequest;
    if (OriginalXHR && OriginalXHR.prototype) {
      const originalOpen = OriginalXHR.prototype.open;
      const originalSend = OriginalXHR.prototype.send;

      OriginalXHR.prototype.open = function (method, url) {
        this._cnCaptureKind = getCaptureKind(url);
        this._cnCaptureUrl = url;
        if (this._cnCaptureKind) {
          LOG(`XHR.open() intercepted ${this._cnCaptureKind}:`, url);
        }
        return originalOpen.apply(this, arguments);
      };

      OriginalXHR.prototype.send = function (body) {
        const kind = this._cnCaptureKind;
        if (kind) {
          this.addEventListener('load', () => {
            handleCapturedResponse(kind, body || '', this.responseText);
          });
        }
        return originalSend.apply(this, arguments);
      };
    }

    LOG('installInterceptors: done, fetch/XHR patched successfully');
  }

  // Install as early as possible so the page's initial calls are not missed.
  try {
    installInterceptors();
  } catch (e) {
    LOG_ERR('installInterceptors failed — network capture disabled, but continuing:', e);
  }

  // ---- PGN formatting ----

  // Lichess studies only recognize standard PGN tags — [ChapterName "..."]
  // drives the sidebar chapter title, [Event] is shown as game info, and
  // WhiteElo/BlackElo render as a rating badge — so puzzle metadata is folded
  // into those fields exactly as in the original script.
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
    const themeSuffix = puzzle.tags && puzzle.tags.length
      ? ` - ${puzzle.tags.join(', ')}`
      : '';
    const eventName = `${difficultyType === 'HARD' ? 'Hard' : 'Easy'}${themeSuffix}`;

    let result = pgnText;
    result = setPgnTag(result, 'ChapterName', chapterName);
    result = setPgnTag(result, 'Event', eventName);
    result = setPgnTag(result, 'WhiteElo', puzzle.difficulty);
    result = setPgnTag(result, 'BlackElo', puzzle.difficulty);
    return result;
  }

  // The compact individual /puzzle payload replaces some descriptive source
  // tags with "?". These two fields are recoverable from data already present
  // in that same passive response, so restore them before running the original
  // addPuzzleTags() pipeline.
  function inferWhiteTopic(puzzle) {
    if (!puzzle || !Array.isArray(puzzle.tags) || !puzzle.tags.length) return '';

    const topic = String(puzzle.tags[0]);

    // The richer fetchpuzzles PGNs use this singular spelling even though the
    // API topic is plural. Preserve that known source convention.
    if (topic === 'Passed Pawns') return 'Passed Pawn';

    return topic;
  }

  function inferBlackLevel(puzzle) {
    // Values observed in ChessNeurons' richer fetchpuzzles PGNs. Only fill a
    // value when the difficulty is one of the known levels; otherwise preserve
    // the source "?" rather than inventing data.
    const levelByDifficulty = new Map([
      [1300, '1'],
      [1301, '1'],
      [1400, '1.5'],
      [1401, '1.5'],
      [1402, '1.5'],
      [1650, '2'],
      [1651, '2'],
      [1652, '2.5'],
      [1700, '2.5'],
      [1701, '3']
    ]);

    return levelByDifficulty.get(Number(puzzle && puzzle.difficulty)) || '';
  }

  function restoreRecoverableSinglePuzzleTags(pgnText, puzzle) {
    if (!puzzle || puzzle._captureSource !== 'SINGLE_PUZZLE') return pgnText;

    let result = pgnText;

    const whiteTopic = inferWhiteTopic(puzzle);
    if (whiteTopic && /\[White\s+"(?:\?|)"\]/.test(result)) {
      result = setPgnTag(result, 'White', whiteTopic);
    }

    const blackLevel = inferBlackLevel(puzzle);
    if (blackLevel && /\[Black\s+"(?:\?|)"\]/.test(result)) {
      result = setPgnTag(result, 'Black', blackLevel);
    }

    return result;
  }

  // Reformats a single-line "[Tag \"v\"] [Tag \"v\"] ... 1. e4 e5 *" PGN into
  // the conventional layout: one tag pair per line, a blank line, then movetext.
  function prettyPrintPgn(pgnText) {
    const tagRe = /\[[A-Za-z0-9_]+\s+"(?:[^"\\]|\\.)*"\]/g;
    const tags = pgnText.match(tagRe) || [];
    const movetext = pgnText.replace(tagRe, '').trim();
    return tags.join('\n') + (movetext ? `\n\n${movetext}` : '');
  }

  function formatPuzzlePgn(puzzle, difficultyType) {
    let decrypted = decryptPuzzle(puzzle.id, puzzle.activeDate, puzzle.pgn);
    decrypted = restoreRecoverableSinglePuzzleTags(decrypted, puzzle);
    return prettyPrintPgn(addPuzzleTags(decrypted, puzzle, difficultyType));
  }

  function puzzlesToPgn(list, difficultyType) {
    const sortByName = (a, b) => parseInt(a.name, 10) - parseInt(b.name, 10);
    const sorted = [...list].sort(sortByName);
    return sorted
      .map((p) => formatPuzzlePgn(p, difficultyType))
      .join('\n\n\n');
  }

  function openedPuzzlesToPgn(list) {
    return [...list]
      .map((p) => formatPuzzlePgn(
        p,
        p._difficultyType || resolvePuzzleDifficultyType(p)
      ))
      .join('\n\n\n');
  }

  function sectionToPgn(key, list) {
    return key === 'OPENED'
      ? openedPuzzlesToPgn(list)
      : puzzlesToPgn(list, key);
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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderPuzzle(puzzle, difficultyType) {
    const finalPgn = formatPuzzlePgn(
      puzzle,
      difficultyType || puzzle._difficultyType || resolvePuzzleDifficultyType(puzzle)
    );
    const tags = (puzzle.tags || []).join(', ');

    return `
      <div class="cn-puzzle-block">
        <div class="cn-puzzle-title">#${escapeHtml(puzzle.name)} (difficulty ${escapeHtml(puzzle.difficulty)}) — ${escapeHtml(puzzle.fen || '')}</div>
        <div class="cn-puzzle-tags">${escapeHtml(tags)}</div>
        <div class="cn-pgn-text">${escapeHtml(finalPgn)}</div>
      </div>
    `;
  }

  function renderPuzzleSections(easyList, hardList, openedList, collapsedState) {
    const sortByName = (a, b) => parseInt(a.name, 10) - parseInt(b.name, 10);
    const easy = [...easyList].sort(sortByName);
    const hard = [...hardList].sort(sortByName);
    const opened = [...openedList];

    const section = (title, key, list, difficultyType) => `
      <div class="cn-section-title">
        <span class="cn-section-toggle" data-toggle-key="${key}">
          <span class="cn-caret">${collapsedState[key] ? '▸' : '▾'}</span> ${title} (${list.length})
        </span>
        <span>
          <button class="cn-copy-btn" data-key="${key}" ${list.length ? '' : 'disabled'}>Copy</button>
          <button class="cn-download-btn" data-key="${key}" ${list.length ? '' : 'disabled'}>Download</button>
        </span>
      </div>
      <div class="cn-section-body" data-body-key="${key}" ${collapsedState[key] ? 'style="display:none"' : ''}>
        ${list.length
          ? list.map((p) => renderPuzzle(p, difficultyType)).join('')
          : '<div class="cn-puzzle-tags">Not captured yet.</div>'}
      </div>
    `;

    return (
      section('EASY', 'EASY', easy, 'EASY') +
      section('HARD', 'HARD', hard, 'HARD') +
      section('OPENED / HISTORY', 'OPENED', opened, null)
    );
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

  const sectionCollapsed = {
    EASY: true,
    HARD: true,
    OPENED: false
  };

  function renderPanelBody(body) {
    const easy = capturedPuzzles.EASY;
    const hard = capturedPuzzles.HARD;
    const opened = capturedPuzzles.OPENED;

    const haveEasy = Array.isArray(easy);
    const haveHard = Array.isArray(hard);
    const haveOpened = opened.length > 0;

    let statusHtml;
    if (haveEasy || haveHard || haveOpened) {
      const parts = [];
      if (haveEasy) parts.push(`${easy.length} Easy`);
      if (haveHard) parts.push(`${hard.length} Hard`);
      if (haveOpened) parts.push(`${opened.length} opened/history`);
      statusHtml = `<div class="cn-status-line cn-status-ok">Passively captured ${parts.join(', ')} puzzle${parts.length === 1 && ((haveEasy && easy.length === 1) || (haveHard && hard.length === 1) || (haveOpened && opened.length === 1)) ? '' : 's'}.</div>`;
    } else {
      statusHtml = '<div class="cn-status-line cn-status-waiting">Waiting for the page to call fetchpuzzles or /puzzle…</div>';
    }

    body.innerHTML = statusHtml + renderPuzzleSections(
      easy || [],
      hard || [],
      opened,
      sectionCollapsed
    );

    // innerHTML replacement wipes listeners, so rewire every render.
    body.querySelectorAll('.cn-copy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const list = capturedPuzzles[key] || [];
        navigator.clipboard.writeText(sectionToPgn(key, list))
          .then(() => LOG(`Copy (${key}): copied to clipboard`))
          .catch((e) => LOG_ERR(`Copy (${key}): failed`, e));
      });
    });

    body.querySelectorAll('.cn-download-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const list = capturedPuzzles[key] || [];
        downloadText(
          `chessneurons-${key.toLowerCase()}.pgn`,
          sectionToPgn(key, list)
        );
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
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;

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

    document.addEventListener('mouseup', () => {
      dragging = false;
    });
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
    LOG('showToggleButton: button appended to document.body');
  }

  function updateToggleButtonState(btn) {
    const captured = Array.isArray(capturedPuzzles.EASY)
      || Array.isArray(capturedPuzzles.HARD)
      || capturedPuzzles.OPENED.length > 0;

    btn.disabled = !captured;
    btn.textContent = captured
      ? 'Show Decrypted PGNs'
      : 'Waiting for puzzles…';
  }

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
